'use client';

/**
 * BetaFooterWrapper — W4.Fri.
 *
 * Client component that:
 * - Mounts BetaRedeemClient (runs the invite-redeem + /v1/beta/me fetch)
 * - Renders the cohort badge in the footer when the user has redeemed an invite
 */
import { useState } from 'react';
import { BetaRedeemClient, BetaCohortBadge } from './BetaRedeemClient';

export function BetaFooterWrapper({ apiUrl }: { apiUrl: string }) {
  const [cohort, setCohort] = useState<string | null>(null);

  return (
    <>
      <BetaRedeemClient apiUrl={apiUrl} onCohort={setCohort} />
      <BetaCohortBadge cohort={cohort} />
    </>
  );
}
