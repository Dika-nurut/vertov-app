import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import type { BetterAuthPlugin } from 'better-auth';

/**
 * Yandex ID SUGGEST-widget bridge.
 *
 * The official `YaAuthSuggest` widget (response_type=token) runs client-side and
 * hands the browser a Yandex access token via its token page; the browser POSTs
 * it here. We verify it server-side against Yandex (`login.yandex.ru/info` with
 * the `OAuth <token>` scheme — NOT Bearer) so it can't be forged, then mint a
 * real better-auth session (same providerId 'yandex' as the redirect flow, so it
 * links to the same user). Mounted only when Yandex creds are present.
 */

interface YandexInfo {
  id?: string;
  login?: string;
  default_email?: string;
  emails?: string[];
  display_name?: string;
  real_name?: string;
  first_name?: string;
  last_name?: string;
  default_avatar_id?: string;
  is_avatar_empty?: boolean;
}

async function verifyYandexToken(accessToken: string): Promise<{
  id: string;
  email: string;
  name: string;
  image?: string;
} | null> {
  let res: Response;
  try {
    res = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const p = (await res.json().catch(() => null)) as YandexInfo | null;
  if (!p || !p.id) return null;
  const email = p.default_email ?? p.emails?.[0] ?? null;
  if (!email) return null;
  const image =
    p.default_avatar_id && !p.is_avatar_empty
      ? `https://avatars.yandex.net/get-yapic/${p.default_avatar_id}/islands-200`
      : undefined;
  return {
    id: String(p.id),
    email,
    name: p.display_name ?? p.real_name ?? p.login ?? email,
    ...(image ? { image } : {}),
  };
}

export function yandexSuggestBridge(): BetterAuthPlugin {
  return {
    id: 'yandex-suggest-bridge',
    endpoints: {
      yandexBridge: createAuthEndpoint('/yandex/bridge', { method: 'POST' }, async (ctx) => {
        const body = (ctx.body ?? {}) as { accessToken?: unknown };
        const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
        if (!accessToken) {
          return ctx.json({ error: 'missing_token' }, { status: 400 });
        }
        const profile = await verifyYandexToken(accessToken);
        if (!profile) {
          return ctx.json({ error: 'yandex_verify_failed' }, { status: 401 });
        }
        const result = await handleOAuthUserInfo(ctx, {
          userInfo: {
            id: profile.id,
            email: profile.email.toLowerCase(),
            emailVerified: true,
            name: profile.name,
            image: profile.image || undefined,
          },
          account: { providerId: 'yandex', accountId: profile.id, accessToken },
          callbackURL: '/generate',
          disableSignUp: false,
        });
        if (result.error || !result.data) {
          ctx.context.logger.error(`yandex bridge sign-in failed: ${result.error ?? 'no data'}`);
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
