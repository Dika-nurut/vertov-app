'use client';

/**
 * BetaRedeemClient — W4.Fri.
 *
 * Mounted in AppShell. On mount:
 * 1. Reads the `seed_beta_code` cookie (set by /i/[code]).
 * 2. POSTs to /v1/beta/redeem — one-time.
 * 3. On 200 or 409 (already redeemed), clears the cookie.
 *
 * Also fetches GET /v1/beta/me to display the cohort name in the footer.
 * Renders nothing visible — parent uses the cohort state passed up via
 * the `onCohort` callback.
 */
import { useEffect, useState } from 'react';

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; path=/`;
}

export function BetaRedeemClient({
  apiUrl,
  onCohort,
}: {
  apiUrl: string;
  onCohort: (cohort: string | null) => void;
}) {
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;
    setDone(true);

    const run = async () => {
      // Try to redeem the cookie-held invite code.
      const code = getCookie('seed_beta_code');
      if (code) {
        try {
          const res = await fetch(`${apiUrl}/v1/beta/redeem`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          // Clear the cookie on any definitive response (200, 4xx, 5xx).
          // Only keep the cookie if the network itself failed (res undefined)
          // so the browser can retry on the next mount. A 404 or 409 both
          // indicate the server processed the request — retrying forever
          // would loop infinitely. (#12 audit fix)
          deleteCookie('seed_beta_code');
        } catch {
          // Non-fatal — the cookie will retry on the next mount.
        }
      }

      // Always fetch /v1/beta/me so the footer shows the cohort for
      // users who already redeemed (even without a cookie).
      try {
        const res = await fetch(`${apiUrl}/v1/beta/me`, {
          credentials: 'include',
        });
        if (res.ok) {
          const body = (await res.json()) as { cohort: string | null };
          onCohort(body.cohort ?? null);
        }
      } catch {
        // Non-fatal — footer just won't show the cohort badge.
      }
    };

    void run();
  }, [done, apiUrl, onCohort]);

  return null;
}

/**
 * BetaCohortFooter — renders inline cohort badge.
 * Shown only when cohort is non-null.
 */
export function BetaCohortBadge({ cohort }: { cohort: string | null }) {
  if (!cohort) return null;
  return (
    <>
      <span>·</span>
      <span
        data-testid="beta-cohort-badge"
        className="font-medium text-[color:var(--color-primary)]"
      >
        Бета · {cohort}
      </span>
    </>
  );
}
