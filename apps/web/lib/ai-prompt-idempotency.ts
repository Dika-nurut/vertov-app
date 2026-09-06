/**
 * Client-side identity rules for the paid AI-промпт request.
 *
 * A transport failure is ambiguous: the API may have already stored the paid
 * draft. The node therefore keeps its claim key until success is observed. A
 * terminal server response, on the other hand, has closed the claim and must
 * not be retried with the same key.
 */

export function aiPromptClaimKey(existing: string | undefined, create: () => string): string {
  return existing && existing.length > 0 ? existing : create();
}

export function shouldRetainAiPromptClaim(response: { status: number; error?: unknown }): boolean {
  return (
    response.status === 409 &&
    response.error !== 'prompt_studio_retry_with_new_key' &&
    response.error !== 'prompt_studio_idempotency_key_reused'
  );
}
