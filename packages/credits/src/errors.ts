export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS';
  readonly available: number;
  readonly requested: number;

  constructor(available: number, requested: number) {
    super(`insufficient credits: have ${available}, need ${requested}`);
    this.name = 'InsufficientCreditsError';
    this.available = available;
    this.requested = requested;
  }
}

export class InvalidAmountError extends Error {
  readonly code = 'INVALID_AMOUNT';
  constructor(amount: number) {
    super(`amount must be a positive integer, got ${amount}`);
    this.name = 'InvalidAmountError';
  }
}

/**
 * SF-10: a commit/refund tried to settle more than the job's outstanding
 * reservation — i.e. book spend that was never reserved. A buggy enqueuer
 * bug, not a user-facing condition; we refuse it to keep the ledger honest.
 */
export class UnreservedSpendError extends Error {
  readonly code = 'UNRESERVED_SPEND';
  readonly outstanding: number;
  readonly requested: number;
  constructor(outstanding: number, requested: number) {
    super(`unreserved spend: outstanding reservation ${outstanding}, requested ${requested}`);
    this.name = 'UnreservedSpendError';
    this.outstanding = outstanding;
    this.requested = requested;
  }
}

/**
 * A retry key was already used for a different ledger effect. Replaying an
 * idempotency key is safe only when its financial identity is unchanged;
 * silently returning the old row would make a caller believe a new user,
 * amount, or job had been settled.
 */
export class IdempotencyKeyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`idempotency key is already bound to a different credit operation`);
    this.name = 'IdempotencyKeyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}
