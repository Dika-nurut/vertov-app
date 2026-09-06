/**
 * Composite provider-handle persistence format for `jobs.provider_job_id`.
 *
 * A paid async provider job is resumable across BullMQ retries ONLY if we know
 * which vendor minted its id. We encode that binding as `${gateway}::${id}` into
 * the existing text column (no schema migration — pending migrations on other
 * branches would collide). On retry the worker parses it back and resumes
 * strictly through the minting gateway; a legacy bare id (pre-composite) or an
 * unparseable value is treated as unbindable and triggers a fresh generation.
 *
 * Pure string helpers — no infra, unit-tested in resume-token.test.ts.
 */

// Gateway keys are lowercase alphanumerics + hyphen (the {@link Gateway} union
// in @seed/provider-byteplus). Because the key can't contain a colon, the FIRST
// `::` is unambiguously the delimiter and the id may itself contain colons.
const RESUME_TOKEN_RE = /^([a-z0-9-]+)::(.+)$/;

export interface ResumeToken {
  gateway: string;
  providerJobId: string;
}

/** Encode a gateway-bound provider handle for storage in `jobs.provider_job_id`. */
export function encodeResumeToken(gateway: string, providerJobId: string): string {
  return `${gateway}::${providerJobId}`;
}

/**
 * Parse a stored `jobs.provider_job_id`. Returns the `{ gateway, providerJobId }`
 * binding for a composite value, or `null` for a legacy bare id / any value that
 * doesn't carry a gateway prefix — the caller must treat `null` as unbindable.
 */
export function parseResumeToken(stored: string): ResumeToken | null {
  const match = RESUME_TOKEN_RE.exec(stored);
  if (!match) return null;
  return { gateway: match[1]!, providerJobId: match[2]! };
}
