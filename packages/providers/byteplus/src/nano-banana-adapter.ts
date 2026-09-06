import type { GenerationHandle, GenerationResult, ProviderAdapter, WorkflowSpec } from './types';

/**
 * Circuit-breaker over the Nano Banana family: laozhang.ai (primary, ~50-63%
 * cheaper than OpenRouter — verified 2026-07-02) with kie.ai as fallback.
 * Non-negotiable per `research/archive/gemini-egress-gateway-backlog-2026-06.md` §4 —
 * a cheap-path outage must never surface as a stuck/failed job, see
 * `[[cjm-no-infinite-loading-guard]]`.
 *
 * kie.ai's own async poll happens INSIDE generate() (not deferred to
 * awaitResult()) so the outer contract stays identical to the sync,
 * inlineResult-attached shape both backends already produce — the worker
 * never needs to know a fallback happened.
 */
export class NanoBananaAdapter implements ProviderAdapter {
  constructor(
    private readonly primary: ProviderAdapter,
    private readonly fallback: ProviderAdapter,
  ) {}

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    try {
      return await this.primary.generate(spec);
    } catch (primaryErr) {
      try {
        const handle = await this.fallback.generate(spec);
        const result = await this.fallback.awaitResult(handle, spec);
        return {
          providerJobId: handle.providerJobId,
          inlineResult: {
            ...result,
            meta: {
              ...result.meta,
              fellBackFrom: 'laozhang',
              primaryError: (primaryErr as Error).message,
            },
          },
        };
      } catch (fallbackErr) {
        throw new AggregateError(
          [primaryErr, fallbackErr],
          `laozhang.ai and kie.ai both failed: ${(primaryErr as Error).message} | ${(fallbackErr as Error).message}`,
        );
      }
    }
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    if (handle.inlineResult) return handle.inlineResult;
    return this.primary.awaitResult(handle, spec);
  }
}
