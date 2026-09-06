import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import type { BetterAuthPlugin } from 'better-auth';

/**
 * VK ID OneTap bridge.
 *
 * The VK ID widget (client-side) authenticates the user with VK — and the
 * federated **Odnoklassniki + Mail.ru** (`oauthList`) — then hands the browser a
 * VK access token via `VKID.Auth.exchangeCode`. The widget alone does NOT create
 * a Vertov session, so the browser POSTs that token here; we verify it
 * server-side against VK (so it can't be forged) and mint a real better-auth
 * session via the same path the native OAuth callback uses (`handleOAuthUserInfo`
 * → `setSessionCookie`). All three VK-group logins come from ONE VK app.
 *
 * Mounted only when VK creds are present (see index.ts).
 */

// VK/OK/Mail.ru identities can arrive without an email; the `user` table requires
// one, so we mint a per-id sentinel on this domain (ensureUserRows maps it to NULL
// PII — same pattern as phone sign-up's @phone.vertov.local).
export const VK_TEMP_EMAIL_DOMAIN = 'vk.vertov.local';

interface VkIdUser {
  user_id: string | number;
  email?: string;
  first_name?: string;
  last_name?: string;
  avatar?: string;
}

/**
 * Verify a VK ID access token server-side via VK's `user_info` — this proves the
 * token is real AND issued to OUR app (client_id pins it), so a forged/foreign
 * token can't mint a session. Returns the verified profile or null.
 */
async function verifyVkIdToken(accessToken: string): Promise<VkIdUser | null> {
  const clientId = process.env.VK_CLIENT_ID;
  if (!clientId) return null;
  let res: Response;
  try {
    res = await fetch('https://id.vk.com/oauth2/user_info', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, access_token: accessToken }).toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { user?: VkIdUser } | null;
  const u = data?.user;
  if (!u || u.user_id === undefined || u.user_id === null) return null;
  return u;
}

export function vkIdBridge(): BetterAuthPlugin {
  return {
    id: 'vk-id-bridge',
    endpoints: {
      vkIdBridge: createAuthEndpoint('/vkid/bridge', { method: 'POST' }, async (ctx) => {
        const body = (ctx.body ?? {}) as { accessToken?: unknown };
        const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
        if (!accessToken) {
          return ctx.json({ error: 'missing_token' }, { status: 400 });
        }
        const profile = await verifyVkIdToken(accessToken);
        if (!profile) {
          return ctx.json({ error: 'vk_verify_failed' }, { status: 401 });
        }
        const vkId = String(profile.user_id);
        const email = (profile.email ?? `${vkId}@${VK_TEMP_EMAIL_DOMAIN}`).toLowerCase();
        const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || email;

        const result = await handleOAuthUserInfo(ctx, {
          userInfo: {
            id: vkId,
            email,
            emailVerified: Boolean(profile.email),
            name,
            image: profile.avatar || undefined,
          },
          account: { providerId: 'vkid', accountId: vkId, accessToken },
          callbackURL: '/generate',
          disableSignUp: false,
        });
        if (result.error || !result.data) {
          ctx.context.logger.error(`vkid bridge sign-in failed: ${result.error ?? 'no data'}`);
          return ctx.json({ error: 'signin_failed' }, { status: 400 });
        }
        await setSessionCookie(ctx, {
          session: result.data.session,
          user: result.data.user,
        });
        return ctx.json({ ok: true });
      }),
    },
  };
}
