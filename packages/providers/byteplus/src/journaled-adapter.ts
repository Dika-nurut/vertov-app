import {
  AmbiguousSubmitError,
  isAmbiguousSubmitError,
  isProvablyUnbilledProviderError,
  type AttemptJournalPort,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';

export interface JournaledAdapterOptions {
  /** Safe refusal is the production default; false is an explicit legacy escape hatch. */
  safeAtMostOnce?: boolean;
}

/**
 * Worker-owned durable submit coordinator. It is deliberately a leaf wrapper:
 * a circuit breaker or fallback chain has no persistence port and therefore
 * only propagates the ambiguity marker this wrapper raises.
 */
export class JournaledAdapter implements ProviderAdapter {
  private readonly safeAtMostOnce: boolean;

  constructor(
    private readonly gateway: string,
    private readonly inner: ProviderAdapter,
    private readonly journal: AttemptJournalPort,
    options: JournaledAdapterOptions = {},
  ) {
    this.safeAtMostOnce = options.safeAtMostOnce ?? true;
  }

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (!spec.jobId) {
      throw new Error(
        `attempt journaling requires WorkflowSpec.jobId for gateway '${this.gateway}'`,
      );
    }

    const legContext = spec.attemptContext?.legs?.[this.gateway] ?? spec.attemptContext;
    const { attemptId } = await this.journal.beginAttempt({
      jobId: spec.jobId,
      gateway: this.gateway,
      modelId: spec.modelId,
      ...(legContext?.legIdentity ? { legIdentity: legContext.legIdentity } : {}),
      ...(legContext?.rung ? { rung: legContext.rung } : {}),
      ...(legContext?.role ? { role: legContext.role } : {}),
      ...(legContext?.units === undefined ? {} : { units: legContext.units }),
      ...(legContext?.configuredExpectedCostRub === undefined
        ? {}
        : { configuredExpectedCostRub: legContext.configuredExpectedCostRub }),
      ...(legContext?.revenueRub === undefined ? {} : { revenueRub: legContext.revenueRub }),
    });

    let handle: GenerationHandle;
    try {
      handle = await this.inner.generate(spec);
    } catch (error) {
      const recorded = await this.recordSubmitFailure(attemptId, error);
      if (isProvablyUnbilledProviderError(error) && recorded) throw error;
      if (!this.safeAtMostOnce) throw error;
      throw new AmbiguousSubmitError(error);
    }

    const accepted = {
      attemptId,
      // The journal names the executable leg, not merely the transport used
      // inside it. In particular, official OpenRouter delegates to the normal
      // OpenRouter client but remains a distinct capped leg in the ledger.
      gateway: this.gateway,
      providerJobId: handle.providerJobId,
    };
    try {
      // This write is part of the acceptance boundary. If it fails after the
      // vendor id was received, retry the idempotent journal write once: this
      // is the one narrow recovery case where the id exists. If the retry also
      // fails, the submit remains ambiguous and the worker must refuse a
      // second paid request.
      await this.journal.recordAccepted(accepted);
    } catch (firstError) {
      try {
        await this.journal.recordAccepted(accepted);
      } catch (secondError) {
        await this.recordSubmitFailure(attemptId, secondError, true);
        if (!this.safeAtMostOnce) throw secondError;
        throw new AmbiguousSubmitError(secondError);
      }
      // The first write may have partially completed before throwing. The
      // second successful write makes the accepted handle durable and safe to
      // return; retain the first error only for diagnostics, not as a submit
      // failure.
      void firstError;
    }

    // Bind future polling to the same leaf wrapper that recorded the attempt.
    // This keeps the official-OpenRouter budget wrapper in the resume path;
    // the inner client gateway is not the accounting identity.
    return { ...handle, gateway: this.gateway, attemptId };
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    return this.inner.awaitResult(handle, spec);
  }

  private async recordSubmitFailure(
    attemptId: string,
    error: unknown,
    persistenceFailure = false,
  ): Promise<boolean> {
    if (isAmbiguousSubmitError(error)) return true;
    try {
      if (!persistenceFailure && isProvablyUnbilledProviderError(error)) {
        await this.journal.recordDefinitiveFailure({ attemptId, error });
      } else {
        await this.journal.recordAmbiguous({ attemptId, error });
      }
      return true;
    } catch {
      // The intent row is still the refusal evidence. Do not turn a journal
      // outage into permission to submit a second paid request.
      return false;
    }
  }
}
