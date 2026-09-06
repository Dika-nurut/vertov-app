/**
 * The port through which the third leg of the image chain books its loss against
 * finance's budget before submitting (2026-08-02 ruling, Ask 8 option b — 3 000 ₽/day,
 * 20 000 ₽/rolling month of accumulated negative margin).
 *
 * The counter itself is a database table and lives in `@seed/db`; this package
 * has no database dependency and must not grow one, so the process that owns a
 * connection (the worker) registers an implementation at boot.
 *
 * The port asks for a RESERVATION, not for permission. A `hasHeadroom()` read
 * followed by a submit is a race with no lock in it: during the outage this leg
 * exists for, every concurrent job reads the same headroom and every one of them
 * goes out, so the overshoot is bounded by concurrency rather than by the cap.
 * One call that both decides and books is the only shape that caps anything.
 *
 * **Unregistered is fail-closed**: with no budget there is no third leg at all
 * (`officialOpenRouterLeg` returns null and the chain is 2-leg), rather than an
 * unmetered leg. That is the whole point — the leg used to arm itself.
 */

export interface OfficialLegReservationRequest {
  /** The job this spend belongs to. Also the key the settlement finds it by. */
  jobId: string;
  modelId: string;
  /** Price-point rung the request lands on — costed and charged at the same rung. */
  rung: string;
  /** Billable units about to be submitted (worst case: what we will be charged for). */
  units: number;
  /** Third-leg USD per unit at `rung`, from `@seed/shared/official-leg-cost`. */
  usdPerUnit: number;
}

export type OfficialLegReservationOutcome =
  | {
      reserved: true;
      /**
       * Handle on THIS attempt's booking. A job is submitted again after a
       * retryable failure and every submit is a separate real charge, so a
       * release has to name the attempt it is giving back — releasing "the
       * job's" reservation erased the charges of attempts that had been billed.
       */
      attemptId: string;
    }
  | {
      reserved: false;
      /** `no-credit-floor`: the catalogue prices no credit, so this leg can only lose. */
      reason: 'no-credit-floor' | 'budget-exhausted';
    };

export interface OfficialLegBudget {
  /** Book this job's worst-case loss. `reserved: false` means it must not be submitted. */
  reserve(request: OfficialLegReservationRequest): Promise<OfficialLegReservationOutcome>;
  /** Hand ONE attempt's reservation back — only when the vendor provably never billed it. */
  release(attemptId: string): Promise<void>;
}

let registered: OfficialLegBudget | null = null;

/** Install the budget counter (worker boot), or `null` to remove it (tests). */
export function setOfficialLegBudget(budget: OfficialLegBudget | null): void {
  registered = budget;
}

/** The installed counter, or `null` when nothing registered one. */
export function officialLegBudget(): OfficialLegBudget | null {
  return registered;
}
