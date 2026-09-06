'use client';

import { useEffect } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * M8 (152-ФЗ): records server-side consent for the redirect/email auth paths
 * (OAuth, magic-link) that can't record it inline on the login page. The login
 * page sets `vertov_consent_pending` when the user affirms consent; on the first
 * authenticated landing this flushes it to POST /v1/consent and clears the flag.
 * Best-effort and idempotent — a 401 (no session yet) leaves the flag for the next
 * authenticated load; the server skips already-recorded documents.
 */
export function ConsentFlush(): null {
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = localStorage.getItem('vertov_consent_pending');
    } catch {
      return;
    }
    if (!pending) return;
    void fetch(`${API_URL}/v1/consent`, { method: 'POST', credentials: 'include' })
      .then((r) => {
        if (r.ok) {
          try {
            localStorage.removeItem('vertov_consent_pending');
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {
        /* non-blocking; retried on the next authenticated load */
      });
  }, []);
  return null;
}
