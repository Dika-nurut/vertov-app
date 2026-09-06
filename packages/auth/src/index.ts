import { createHash } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  anonymous,
  emailOTP,
  genericOAuth,
  magicLink,
  organization,
  phoneNumber,
  twoFactor,
} from 'better-auth/plugins';
import { eq, sql } from 'drizzle-orm';
import { AUTH_EMAIL_QUEUE } from '@seed/credits';
import { boards, db, nid, outboxJobs, scripts, studioProjects, usersApp, usersPii } from '@seed/db';
import { resolveAuthSecret, shouldUseSecureCookies } from './config';
import { isLoopbackOrigin } from './trusted-origins';
import { vkIdBridge } from './vk-id-bridge';
import { yandexSuggestBridge } from './yandex-bridge';

export { resolveAuthSecret, shouldUseSecureCookies, DEV_AUTH_SECRET } from './config';

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:4000';
// BL-12: fail closed — this throws at boot if BETTER_AUTH_SECRET is the dev
// default or unset under NODE_ENV=production (forgeable sessions otherwise).
const BETTER_AUTH_SECRET = resolveAuthSecret();

// RU-market social login is cred-gated: each provider only mounts once its
// client id + secret are present, so dev/e2e and a credential-less prod boot are
// unaffected (empty socialProviders, Yandex plugin absent).
const VK_ENABLED = Boolean(process.env.VK_CLIENT_ID && process.env.VK_CLIENT_SECRET);
const YANDEX_ENABLED = Boolean(process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET);
// Another free, "nothing-extra" provider (no договор/active-user-base gate,
// unlike Tinkoff/Sber): Mail.ru ID (genericOAuth, RU-native — pairs with the
// Mail.ru-for-business inbox on vertov.space). Cred-gated like the rest.
const MAILRU_ENABLED = Boolean(process.env.MAILRU_CLIENT_ID && process.env.MAILRU_CLIENT_SECRET);
// Odnoklassniki (genericOAuth) — needs THREE values: client id, secret, and the
// app's PUBLIC key (used in the signed REST call). Gated on all three.
const OK_ENABLED = Boolean(
  process.env.OK_CLIENT_ID && process.env.OK_CLIENT_SECRET && process.env.OK_PUBLIC_KEY,
);
/** Lowercase-hex MD5 — Odnoklassniki's REST API request signature uses it. */
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

// Email code login (emailOTP): the owner prefers entering a short CODE over
// clicking a link. 6 digits, 10-minute validity. Shares the same SMTP transport
// as the magic link. Overridable for parity with the phone OTP knob.
const EMAIL_OTP_LENGTH = Number(process.env.EMAIL_OTP_LENGTH ?? 6);

// Phone OTP (RU): gated on an explicit flag so the endpoints only mount where SMS delivery is wired.
const PHONE_ENABLED = process.env.PHONE_AUTH_ENABLED === '1';
const PHONE_OTP_LENGTH = Number(process.env.PHONE_OTP_LENGTH ?? 4);
// A phone-first signup has no email, but our `user` table requires one — Better
// Auth mints a per-phone sentinel address; the API treats anything on this
// domain as "no email" (stores NULL in users_pii) so it never leaks as contact.
export const PHONE_TEMP_EMAIL_DOMAIN = 'phone.vertov.local';

// Same idea for anonymous() sessions (pre-paywall browsing, 2026-07-07): the
// plugin's own default (`temp@<random>.com`, a different random domain every
// time) is fine as a NOT NULL placeholder in `user.email` but isn't
// pattern-matchable — pinning a fixed domain makes anon accounts recognizable
// in raw DB dumps/logs independent of the `isAnonymous` column. The API side
// (ensureUserRows, apps/api/src/server.ts) doesn't rely on this pattern
// though — it gates on `isAnonymous` directly, which is authoritative.
export const ANON_TEMP_EMAIL_DOMAIN = 'anon.vertov.local';

// Dev capture: magic links, surfaced via /v1/dev/last-magic-link. Keyed BY
// EMAIL (not a single last-writer-wins slot) so concurrent sign-ins — e.g.
// parallel Playwright workers — never clobber each other's link. This is the
// per-worker isolation that lets e2e drop `workers: 1`. `last` is kept for the
// no-arg lookup (back-compat).
type DevLink = { email: string; url: string; at: string };
const devState: { last: DevLink | null; byEmail: Map<string, DevLink> } = {
  last: null,
  byEmail: new Map(),
};
/** Most recent link overall, or the link for a specific email when provided. */
export const getDevLastMagicLink = (email?: string): DevLink | null =>
  email ? (devState.byEmail.get(email) ?? null) : devState.last;

// Same dev-capture pattern for phone OTPs, surfaced via /v1/dev/last-phone-otp.
type DevOtp = { phoneNumber: string; code: string; at: string };
const devPhoneState: { last: DevOtp | null; byPhone: Map<string, DevOtp> } = {
  last: null,
  byPhone: new Map(),
};
export const getDevLastPhoneOtp = (phoneNumber?: string): DevOtp | null =>
  phoneNumber ? (devPhoneState.byPhone.get(phoneNumber) ?? null) : devPhoneState.last;

// Same dev-capture pattern for email OTP codes, surfaced via /v1/dev/last-email-otp.
type DevEmailOtp = { email: string; code: string; at: string };
const devEmailOtpState: { last: DevEmailOtp | null; byEmail: Map<string, DevEmailOtp> } = {
  last: null,
  byEmail: new Map(),
};
export const getDevLastEmailOtp = (email?: string): DevEmailOtp | null =>
  email ? (devEmailOtpState.byEmail.get(email) ?? null) : devEmailOtpState.last;

/**
 * Persist an email delivery request and let the worker talk to SMTP.
 *
 * Better Auth invokes its email callbacks while handling the login request.
 * Calling Nodemailer here made a slow/unreachable SMTP server hold that HTTP
 * request open until the provider timeout.  The outbox row is the durable hand
 * off: the request only waits for a short local Postgres insert, while the
 * worker owns SMTP timeouts and retries.  `jobId` is deterministic for the row
 * so an outbox-drainer crash between `queue.add()` and `processed_at` cannot
 * send a duplicate BullMQ job.
 */
const hasAuthEmailConfig = (): boolean => {
  const port = Number(process.env.SMTP_PORT);
  return Boolean(
    process.env.SMTP_HOST &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      process.env.SMTP_FROM,
  );
};

async function queueAuthEmail(to: string, subject: string, text: string): Promise<boolean> {
  // Preserve the production fail-closed contract for an absent/invalid
  // configuration. A configured-but-unreachable provider is different: it is
  // handed to the worker and retried without blocking this HTTP request.
  if (process.env.NODE_ENV === 'production' && !hasAuthEmailConfig()) {
    throw new Error('auth mailer not configured: set SMTP_HOST+SMTP_FROM');
  }
  const id = nid();
  await db.insert(outboxJobs).values({
    id,
    queueName: AUTH_EMAIL_QUEUE,
    payload: { to, subject, text },
    // BullMQ rejects custom IDs containing `:`. Keep the queue id deterministic
    // for outbox retries while using the same delimiter-safe alphabet as the
    // other settlement and worker job IDs.
    jobId: `auth-email-${id}`,
  });
  return true;
}

async function sendLoginEmail(email: string, url: string): Promise<void> {
  await queueAuthEmail(
    email,
    'Вход в Vertov',
    `Ваша ссылка для входа: ${url}\n\nДействует 15 минут.`,
  );
  // Keep the existing local/dev capture path useful when no worker/SMTP is
  // configured. Never emit a single-use link in production logs.
  if (!hasAuthEmailConfig() && process.env.NODE_ENV !== 'production') {
    console.log(`[magicLink] to=${email} url=${url}`);
  }
}

// Email login CODE (emailOTP). Captured to dev state FIRST — before any delivery
// attempt — so e2e can read it back via /v1/dev/last-email-otp even if the
// transport is down, mirroring the magic-link + phone-OTP capture pattern.
async function sendEmailOtp(email: string, code: string): Promise<void> {
  const otp = { email, code, at: new Date().toISOString() };
  devEmailOtpState.last = otp;
  devEmailOtpState.byEmail.set(email, otp);
  await queueAuthEmail(
    email,
    'Код для входа в Vertov',
    `Ваш код для входа: ${code}\n\nДействует 10 минут. Если вы не запрашивали вход — проигнорируйте письмо.`,
  );
  if (!hasAuthEmailConfig() && process.env.NODE_ENV !== 'production') {
    console.log(`[emailOTP] to=${email} code=${code}`);
  }
}

// Deliver a phone OTP. SMSC.ru flash-call (RU: the code is the last digits of an
// incoming call — ≈0.6₽, far cheaper than SMS, with SMS cascade fallback) when
// SMSC_FLASH_CALL=1; otherwise a plain SMS; otherwise the console (dev/e2e). The
// code is captured first so e2e can read it back via /v1/dev/last-phone-otp.
async function sendPhoneOtp(phoneNumber: string, code: string): Promise<void> {
  const otp = { phoneNumber, code, at: new Date().toISOString() };
  devPhoneState.last = otp;
  devPhoneState.byPhone.set(phoneNumber, otp);

  const apiKey = process.env.SMSC_API_KEY?.trim();
  const login = process.env.SMSC_LOGIN?.trim();
  const password = process.env.SMSC_PASSWORD;
  if (!apiKey && (!login || !password)) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('SMSC is not configured: set SMSC_API_KEY or SMSC_LOGIN+SMSC_PASSWORD');
    console.log(`[phoneOTP] to=${phoneNumber} code=${code}`);
    return;
  }
  const params = new URLSearchParams({
    phones: phoneNumber,
    mes: `Код входа в Vertov: ${code}. Никому не сообщайте его.`,
    fmt: '3', // JSON response
    charset: 'utf-8',
  });
  if (apiKey) params.set('apikey', apiKey);
  else {
    params.set('login', login as string);
    params.set('psw', password as string);
  }
  if (process.env.SMSC_SENDER) {
    // Plain SMS needs a registered sender name ("имя отправителя").
    params.set('sender', process.env.SMSC_SENDER);
  }
  const res = await fetch('https://smsc.ru/sys/send.php', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = (await res.json().catch(() => null)) as { id?: number; error?: string } | null;
  if (!res.ok || !data || data.error) {
    throw new Error(`SMSC send failed: ${data?.error ?? `HTTP ${res.status}`}`);
  }
}

const TRUSTED_ORIGINS = (
  process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? 'http://localhost:3000,http://localhost:4000'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// LOW (audit): trustedOrigins is the CSRF/redirect allow-list. A loopback entry
// in production silently disables it for the real domain — fail closed at boot.
// Checked per-host: dev boxes legitimately list 127.0.0.1/::1 alongside the real
// origin (local e2e would otherwise 403), so it is not enough to look for the
// literal string "localhost".
if (process.env.NODE_ENV === 'production' && TRUSTED_ORIGINS.some(isLoopbackOrigin)) {
  throw new Error(
    'BETTER_AUTH_TRUSTED_ORIGINS must be the real origin(s) in production (refusing loopback: localhost/127.0.0.1/0.0.0.0/::1)',
  );
}

// Claim-on-signup (pre-paywall anonymous browsing, 2026-07-07): fires right
// before the anonymous() plugin deletes the just-linked anonymous user. Better
// Auth's own linking only migrates the AUTH identity (session/account rows) —
// it has no idea a board/scenario/studio-project row's `user_id` needs to move
// too, so that reassignment is hand-written here, the one place both the old
// and new identities are known.
async function claimAnonymousWork({
  anonymousUser,
  newUser,
}: {
  anonymousUser: { user: { id: string } };
  newUser: { user: Record<string, unknown> & { id: string } };
}): Promise<void> {
  const oldId = anonymousUser.user.id;
  const newId = newUser.user.id;
  if (oldId === newId) return;
  await db.transaction(async (tx) => {
    // Coordinate with the anonymous-account reaper. It must not delete the
    // old prefix while this hook is moving owned rows to the real identity.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${oldId}))`);
    // boards/scripts/studio_projects.user_id FKs into users_app — the target
    // row must exist before the reassignment below. A brand-new real signup
    // has none yet (ensureUserRows only runs from GET /v1/me); create it here,
    // mirroring that same upsert. The welcome-program L0 grant is NOT written
    // here — the user's first GET /v1/me applies it via the welcome engine (with
    // anti-farm cluster attribution from the request), so an anon→real conversion
    // enrolls through the exact same path as a fresh email/OAuth signup.
    const existing = await tx
      .select({ id: usersApp.id })
      .from(usersApp)
      .where(eq(usersApp.id, newId))
      .limit(1);
    if (existing.length === 0) {
      const email = typeof newUser.user.email === 'string' ? newUser.user.email : null;
      const realEmail = email && !email.endsWith(`@${PHONE_TEMP_EMAIL_DOMAIN}`) ? email : null;
      await tx
        .insert(usersApp)
        .values({
          id: newId,
          displayName: typeof newUser.user.name === 'string' ? newUser.user.name : null,
          locale: 'ru',
        })
        .onConflictDoNothing({ target: usersApp.id });
      await tx
        .insert(usersPii)
        .values({
          id: newId,
          email: realEmail,
          emailVerifiedAt: realEmail && newUser.user.emailVerified ? new Date() : null,
          phone: typeof newUser.user.phoneNumber === 'string' ? newUser.user.phoneNumber : null,
          phoneVerifiedAt: newUser.user.phoneNumberVerified ? new Date() : null,
        })
        .onConflictDoNothing({ target: usersPii.id });
    }
    await tx.update(boards).set({ userId: newId }).where(eq(boards.userId, oldId));
    await tx.update(scripts).set({ userId: newId }).where(eq(scripts.userId, oldId));
    await tx.update(studioProjects).set({ userId: newId }).where(eq(studioProjects.userId, oldId));
  });
}

const authOptions: BetterAuthOptions = {
  baseURL: BETTER_AUTH_URL,
  secret: BETTER_AUTH_SECRET,
  trustedOrigins: TRUSTED_ORIGINS,
  database: drizzleAdapter(db, { provider: 'pg' }),
  // BL-12: force the `Secure` cookie flag on in production so a session cookie
  // can never ship over a plain-http hop, independent of the baseURL scheme.
  advanced: { useSecureCookies: shouldUseSecureCookies() },
  emailAndPassword: { enabled: false },
  // VK ID is a NATIVE provider in better-auth 1.4.21 — it drives VK's OAuth 2.1
  // + PKCE (S256) automatically. Yandex + Mail.ru have no native provider, so they
  // ride the genericOAuth plugin (see `plugins` below). Each is gated on its creds.
  socialProviders: VK_ENABLED
    ? {
        vk: {
          clientId: process.env.VK_CLIENT_ID as string,
          clientSecret: process.env.VK_CLIENT_SECRET as string,
        },
      }
    : {},
  plugins: [
    // Instant, zero-friction onboarding: «Начать бесплатно» creates an
    // anonymous session in one call (no email, no inbox). The user can link a
    // real email/OAuth/phone identity later to persist + pay — onLinkAccount
    // reassigns whatever they were working on (see claimAnonymousWork above).
    anonymous({ emailDomainName: ANON_TEMP_EMAIL_DOMAIN, onLinkAccount: claimAnonymousWork }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // Capture for dev/e2e (/v1/dev/last-magic-link) BEFORE sending, so the
        // link is observable even if the transport is down or unconfigured.
        const link = { email, url, at: new Date().toISOString() };
        devState.last = link;
        devState.byEmail.set(email, link);
        // Fail SAFE, not open: a mailer outage must NOT 500 the sign-in request.
        // Better Auth returns the same generic success whether or not the
        // address exists (so it never leaks account existence), so a transport
        // failure here is logged for ops and swallowed — the request still
        // succeeds and the user can retry, instead of seeing a 500.
        try {
          await sendLoginEmail(email, url);
        } catch (err) {
          console.error(`[magicLink] delivery failed for ${email}: ${(err as Error).message}`);
        }
      },
      expiresIn: 60 * 15,
    }),
    // Email CODE login (owner preference: type a code, not click a link). Same
    // sign-up-on-first-login behaviour as the magic link; shares the SMTP
    // transport. Delivery failures are swallowed inside sendEmailOtp's caller
    // path below — but unlike magic-link we let a thrown send propagate as the
    // plugin's own error so the client can show "не удалось отправить код" and
    // retry, since there's no link to fall back on. The code is captured to dev
    // state first regardless, so e2e always sees it.
    emailOTP({
      otpLength: EMAIL_OTP_LENGTH,
      expiresIn: 60 * 10,
      // Only the sign-in flow is used; reuse the same sender for all types.
      sendVerificationOTP: async ({ email, otp }) => {
        await sendEmailOtp(email, otp);
      },
    }),
    organization(),
    twoFactor(),
    // Yandex + Mail.ru ID via generic OAuth (neither has a native provider).
    // Both ride ONE genericOAuth plugin (config array) so they coexist; each is
    // appended only when its creds are present.
    ...(() => {
      type OAuthCfg = Parameters<typeof genericOAuth>[0]['config'][number];
      const configs: OAuthCfg[] = [];
      if (YANDEX_ENABLED) {
        // Yandex's /info endpoint expects the `OAuth <token>` auth scheme — not
        // the `Bearer` the default getUserInfo sends — so we map it ourselves.
        configs.push({
          providerId: 'yandex',
          clientId: process.env.YANDEX_CLIENT_ID as string,
          clientSecret: process.env.YANDEX_CLIENT_SECRET as string,
          authorizationUrl: 'https://oauth.yandex.ru/authorize',
          tokenUrl: 'https://oauth.yandex.ru/token',
          scopes: ['login:email', 'login:info', 'login:avatar'],
          getUserInfo: async (tokens) => {
            if (!tokens.accessToken) return null;
            const res = await fetch('https://login.yandex.ru/info?format=json', {
              headers: { Authorization: `OAuth ${tokens.accessToken}` },
            });
            if (!res.ok) return null;
            const p = (await res.json()) as {
              id: string;
              default_email?: string;
              emails?: string[];
              display_name?: string;
              real_name?: string;
              login?: string;
              default_avatar_id?: string;
              is_avatar_empty?: boolean;
            };
            const email = p.default_email ?? p.emails?.[0] ?? null;
            // No email → no usable account (the `user` table requires it).
            if (!email) return null;
            return {
              id: String(p.id),
              email,
              // The address is the user's own confirmed Yandex mailbox.
              emailVerified: true,
              name: p.display_name ?? p.real_name ?? p.login ?? email,
              image:
                p.default_avatar_id && !p.is_avatar_empty
                  ? `https://avatars.yandex.net/get-yapic/${p.default_avatar_id}/islands-200`
                  : undefined,
            };
          },
        });
      }
      if (MAILRU_ENABLED) {
        // Mail.ru ID: userinfo takes the token as a query param (not a Bearer
        // header). VERIFY the profile mapping on the first real login — the exact
        // field shape can only be exercised against the live IdP (cred-gated).
        configs.push({
          providerId: 'mailru',
          clientId: process.env.MAILRU_CLIENT_ID as string,
          clientSecret: process.env.MAILRU_CLIENT_SECRET as string,
          authorizationUrl: 'https://oauth.mail.ru/login',
          tokenUrl: 'https://oauth.mail.ru/token',
          scopes: ['userinfo'],
          getUserInfo: async (tokens) => {
            if (!tokens.accessToken) return null;
            const res = await fetch(
              `https://oauth.mail.ru/userinfo?access_token=${encodeURIComponent(tokens.accessToken)}`,
            );
            if (!res.ok) return null;
            const p = (await res.json()) as {
              id?: string;
              email?: string;
              name?: string;
              nickname?: string;
              first_name?: string;
              last_name?: string;
              image?: string;
            };
            const email = p.email ?? null;
            if (!email || !p.id) return null;
            return {
              id: String(p.id),
              email,
              // The address is the user's own confirmed Mail.ru mailbox.
              emailVerified: true,
              name:
                p.name ||
                [p.first_name, p.last_name].filter(Boolean).join(' ') ||
                p.nickname ||
                email,
              image: p.image || undefined,
            };
          },
        });
      }
      if (OK_ENABLED) {
        // Odnoklassniki: OAuth2 code flow, but its REST API requires a SIGNED
        // request — sig = md5(sorted "k=v" params + md5(access_token + secret)) —
        // plus the app PUBLIC key. Scope is ';'-separated, passed as one token.
        // VERIFY on first real login (signed call can't be unit-tested cred-less).
        configs.push({
          providerId: 'ok',
          clientId: process.env.OK_CLIENT_ID as string,
          clientSecret: process.env.OK_CLIENT_SECRET as string,
          authorizationUrl: 'https://connect.ok.ru/oauth/authorize',
          tokenUrl: 'https://api.ok.ru/oauth/token.do',
          scopes: ['GET_EMAIL;VALUABLE_ACCESS'],
          getUserInfo: async (tokens) => {
            const token = tokens.accessToken;
            if (!token) return null;
            const appKey = process.env.OK_PUBLIC_KEY as string;
            const secret = process.env.OK_CLIENT_SECRET as string;
            const params: Record<string, string> = {
              application_key: appKey,
              fields: 'uid,email,first_name,last_name,name,pic50x50',
              format: 'json',
              method: 'users.getCurrentUser',
            };
            const sessionSecret = md5(token + secret);
            const sig = md5(
              Object.keys(params)
                .sort()
                .map((k) => `${k}=${params[k]}`)
                .join('') + sessionSecret,
            );
            const qs = new URLSearchParams({ ...params, sig, access_token: token });
            const res = await fetch(`https://api.ok.ru/fb.do?${qs.toString()}`);
            if (!res.ok) return null;
            const p = (await res.json()) as {
              uid?: string;
              email?: string;
              name?: string;
              first_name?: string;
              last_name?: string;
              pic50x50?: string;
            };
            const email = p.email ?? null;
            // OK returns email only if the app has GET_EMAIL approved.
            if (!email || !p.uid) return null;
            return {
              id: String(p.uid),
              email,
              emailVerified: true,
              name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || email,
              image: p.pic50x50 || undefined,
            };
          },
        });
      }
      return configs.length ? [genericOAuth({ config: configs })] : [];
    })(),
    // VK ID OneTap bridge — one VK app federates VK + OK + Mail.ru (client widget),
    // this server endpoint verifies the token and mints our session. Same VK creds.
    ...(VK_ENABLED ? [vkIdBridge()] : []),
    // Yandex ID SUGGEST-widget bridge (official client-side button → our session).
    ...(YANDEX_ENABLED ? [yandexSuggestBridge()] : []),
    // Phone-number sign-in / OTP (RU flash-call). Mounts only when enabled.
    ...(PHONE_ENABLED
      ? [
          phoneNumber({
            otpLength: PHONE_OTP_LENGTH,
            sendOTP: async ({ phoneNumber: phone, code }) => {
              await sendPhoneOtp(phone, code);
            },
            // First-time phone users have no email; mint a per-phone sentinel so
            // the NOT NULL `user.email` is satisfied (mapped to NULL PII later).
            signUpOnVerification: {
              getTempEmail: (phone) => `${phone.replace(/\D/g, '')}@${PHONE_TEMP_EMAIL_DOMAIN}`,
              getTempName: (phone) => phone,
            },
          }),
        ]
      : []),
  ],
};

export const auth = betterAuth(authOptions);

export type AuthSession = typeof auth.$Infer.Session;

/**
 * Shared transactional email sender, exposed for non-auth-flow account email
 * (e.g. the profile email-change verification code). It uses the same durable
 * outbox as the magic-link/OTP senders, so profile requests never wait for
 * SMTP either. The boolean is kept for API compatibility and means that the
 * message was accepted by the outbox.
 */
export async function sendAuthEmail(to: string, subject: string, text: string): Promise<boolean> {
  return queueAuthEmail(to, subject, text);
}
