import {
  beginRouteAttempt,
  db,
  readRouteAttemptByProvider,
  readRouteAttemptRecovery,
  recordRouteAttemptAccepted,
  recordRouteAttemptAmbiguous,
  recordRouteAttemptDefinitiveFailure,
  recordRouteAttemptOutcome,
  recordRouteLegSubmitFailure,
  recordRouteLegSubmitSuccess,
} from '@seed/db';
import type { AttemptJournalPort } from '@seed/provider-byteplus';

/** The database-backed port supplied to provider leaf wrappers by the worker. */
export class WorkerAttemptJournal implements AttemptJournalPort {
  private readonly legByAttempt = new Map<string, string>();

  async beginAttempt(input: Parameters<AttemptJournalPort['beginAttempt']>[0]) {
    if (!input.modelId || !input.legIdentity) {
      throw new Error('route attempt context is missing modelId or executable leg identity');
    }
    const result = await beginRouteAttempt({
      jobId: input.jobId,
      modelId: input.modelId,
      gateway: input.gateway,
      legIdentity: input.legIdentity,
      ...(input.rung ? { rung: input.rung } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.units === undefined ? {} : { units: input.units }),
      ...(input.configuredExpectedCostRub === undefined
        ? {}
        : { configuredExpectedCostRub: input.configuredExpectedCostRub }),
      ...(input.revenueRub === undefined ? {} : { revenueRub: input.revenueRub }),
    });
    this.legByAttempt.set(result.attemptId, input.legIdentity);
    return { attemptId: result.attemptId };
  }

  async recordAccepted(input: {
    attemptId: string;
    gateway: string;
    providerJobId: string;
  }): Promise<void> {
    await recordRouteAttemptAccepted(input.attemptId, input.providerJobId, input.gateway);
    await this.recordSubmitSuccess(input.attemptId);
  }

  async recordDefinitiveFailure(input: { attemptId: string; error: unknown }): Promise<void> {
    await recordRouteAttemptDefinitiveFailure(input.attemptId, input.error);
    await this.recordSubmitFailure(input.attemptId);
  }

  async recordAmbiguous(input: { attemptId: string; error: unknown }): Promise<void> {
    await recordRouteAttemptAmbiguous(input.attemptId, input.error);
    await this.recordSubmitFailure(input.attemptId);
  }

  async recordOutcome(
    input: Parameters<NonNullable<AttemptJournalPort['recordOutcome']>>[0],
  ): Promise<void> {
    await recordRouteAttemptOutcome(input);
  }

  rememberAttempt(attemptId: string, legIdentity: string): void {
    this.legByAttempt.set(attemptId, legIdentity);
  }

  async findAttempt(jobId: string, providerJobId: string): Promise<string | null> {
    const row = await readRouteAttemptByProvider(jobId, providerJobId);
    if (!row) return null;
    this.legByAttempt.set(row.id, row.legIdentity);
    return row.id;
  }

  async recovery(jobId: string) {
    return readRouteAttemptRecovery(jobId);
  }

  private async recordSubmitSuccess(attemptId: string): Promise<void> {
    const legIdentity = this.legByAttempt.get(attemptId);
    if (!legIdentity) throw new Error(`attempt ${attemptId} has no leg identity`);
    await recordRouteLegSubmitSuccess(legIdentity);
  }

  private async recordSubmitFailure(attemptId: string): Promise<void> {
    const legIdentity = this.legByAttempt.get(attemptId);
    if (!legIdentity) throw new Error(`attempt ${attemptId} has no leg identity`);
    await recordRouteLegSubmitFailure(legIdentity);
  }
}

export const defaultWorkerAttemptJournal = new WorkerAttemptJournal();

// Keep the shared db import in this module's public construction seam explicit;
// it also makes the ownership boundary obvious in dependency review.
void db;
