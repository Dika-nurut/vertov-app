import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq, inArray } from 'drizzle-orm';
import {
  ServingLegAdapter,
  OfficialOpenRouterFallbackAdapter,
  ProviderError,
  type GenerationHandle,
  type OpenRouterAdapter,
  type ProviderAdapter,
  type WorkflowSpec,
} from '@seed/provider-byteplus';
import {
  db,
  appSettings,
  jobs,
  officialLegSpend,
  pool,
  subscriptionsCatalog,
  OFFICIAL_LEG_DAILY_CAP_KEY,
  OFFICIAL_LEG_FX_RUB,
  OFFICIAL_LEG_MONTHLY_CAP_KEY,
  readOfficialLegSpend,
  reserveOfficialLegSpend,
} from '@seed/db';
import { runJob, type ProviderAdapterFactory } from './job-runner';
import { registerOfficialLegBudget } from './official-leg-budget';
import { sweepStuckJobs } from './reaper';
import { seedUser, seedModel, seedJob, cleanupIntegrationData } from './test-support/seed';
import type { AssetUploadInput, UploadedAsset } from './storage';

/**
 * What the third leg's budget records for each way a generation can end — the
 * whole point of the 2026-08-02 rework.
 *
 * Before it, a row was written only after uploads succeeded AND the guarded
 * `running → succeeded` update claimed the job. Every other ending spends the
 * same provider money and wrote nothing: a response with no usable asset, a
 * fan-out that failed after siblings were billed, an upload crash after
 * generation, the reaper winning the settle race, any terminal failure that
 * refunds the customer. The cap was a counter of successful jobs.
 *
 * These specs drive the REAL `runJob` against the ephemeral DB, through a real
 * `OfficialOpenRouterFallbackAdapter` over a fake OpenRouter, and assert the ₽.
 */

const log = pino({ level: 'silent' });
const NANO_BANANA_PRO_4K_USD = 0.241344;
const ONE_4K_IMAGE_RUB = NANO_BANANA_PRO_4K_USD * OFFICIAL_LEG_FX_RUB;
const OFFICIAL_CAPABILITIES = {
  resolutions: ['1K', '2K', '4K'],
  openrouterFallbackSlug: 'google/gemini-3-pro-image',
  officialUsdPerUnit: { '4K': NANO_BANANA_PRO_4K_USD },
};
/** 1×1 transparent PNG — enough for the upload/thumbnail path to be real. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let userId: string;
let officialModel: string;

/** In-memory store; `failOnPut` simulates a crash after generation was paid for. */
class MemoryStorage {
  failOnPut = false;
  /** Runs before each successful put — used to let the reaper win the race. */
  onPut: (() => Promise<void>) | null = null;
  readonly removed: string[] = [];
  async put(input: AssetUploadInput): Promise<UploadedAsset> {
    if (this.failOnPut) throw new Error('simulated upload failure after a paid generation');
    if (this.onPut) await this.onPut();
    const key = `${input.userId}/${input.jobId}/${input.index}.${input.extension}`;
    return { key, url: `http://stub.local/${key}` };
  }
  async removeObjects(keys: string[]): Promise<void> {
    this.removed.push(...keys);
  }
}

/**
 * The chain as a ban wave leaves it: both gray-market relays dark, so the
 * official leg is the ONLY leg — the configuration in which `chainOrSingle`
 * used to drop the `servedBy` tag entirely.
 */
function collapsedOfficialChain(inner: Partial<OpenRouterAdapter>): ProviderAdapter {
  return new ServingLegAdapter(
    'openrouter-official',
    new OfficialOpenRouterFallbackAdapter(inner as OpenRouterAdapter, {
      reserve: async (request) => {
        const result = await reserveOfficialLegSpend(request);
        return result.reserved
          ? { reserved: true, attemptId: result.attemptId }
          : { reserved: false, reason: result.reason };
      },
      release: async (attemptId) => {
        const { releaseOfficialLegSpend } = await import('@seed/db');
        await releaseOfficialLegSpend(attemptId);
      },
    }),
  );
}

function factoryFor(adapter: ProviderAdapter): ProviderAdapterFactory {
  return {
    getAdapter: () => adapter,
    getAdapterWithFallback: () => adapter,
    getResumeAdapter: () => null,
  };
}

/** An OpenRouter that returns one image inline, exactly as the real image path does. */
function servingOpenRouter(meta?: Record<string, unknown>): Partial<OpenRouterAdapter> {
  const handle: GenerationHandle = {
    providerJobId: 'or-img-test',
    gateway: 'openrouter',
    inlineResult: {
      assets: [{ bytes: PNG_1X1, contentType: 'image/png', extension: 'png' }],
      ...(meta ? { meta } : {}),
    },
  };
  return {
    generate: () => Promise.resolve(handle),
    awaitResult: (h: GenerationHandle) => Promise.resolve(h.inlineResult!),
  };
}

function failingOpenRouter(err: ProviderError): Partial<OpenRouterAdapter> {
  return { generate: () => Promise.reject(err), awaitResult: () => Promise.reject(err) };
}

/**
 * An OpenRouter whose answer changes per submit — the only way to exercise a
 * RETRY, which is where attempt-scoped accounting earns its keep. A step is
 * either an error to throw or the result meta to deliver.
 */
function scriptedOpenRouter(
  steps: ReadonlyArray<ProviderError | Record<string, unknown>>,
  assetCount = 1,
): Partial<OpenRouterAdapter> {
  let submit = 0;
  return {
    generate: () => {
      const step = steps[Math.min(submit++, steps.length - 1)]!;
      if (step instanceof ProviderError) return Promise.reject(step);
      return Promise.resolve({
        providerJobId: `or-img-${submit}`,
        gateway: 'openrouter',
        inlineResult: {
          assets: Array.from({ length: assetCount }, () => ({
            bytes: PNG_1X1,
            contentType: 'image/png',
            extension: 'png',
          })),
          meta: step,
        },
      } as GenerationHandle);
    },
    awaitResult: (h: GenerationHandle) => Promise.resolve(h.inlineResult!),
  };
}

async function legSpendRows(jobId: string) {
  return db.select().from(officialLegSpend).where(eq(officialLegSpend.jobId, jobId));
}

function totalOf(rows: Array<{ costRub: string }>): number {
  return rows.reduce((sum, row) => sum + Number(row.costRub), 0);
}

async function seedOfficialJob(images = 1): Promise<string> {
  const { jobId } = await seedJob({
    userId,
    modelId: officialModel,
    params: { resolution: '4K', n: images },
    creditsReserved: 50 * images,
    creditUnitCost: 50,
  });
  return jobId;
}

async function legSpendRow(jobId: string) {
  const [row] = await db.select().from(officialLegSpend).where(eq(officialLegSpend.jobId, jobId));
  return row;
}

beforeAll(async () => {
  await cleanupIntegrationData();
  registerOfficialLegBudget();
  userId = await seedUser({ tier: 'studio' });
  officialModel = await seedModel({
    kind: 'image',
    capabilities: OFFICIAL_CAPABILITIES,
  });
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
});

beforeEach(async () => {
  await db.delete(officialLegSpend);
  await db.delete(subscriptionsCatalog);
  await db.insert(subscriptionsCatalog).values({
    tier: 'start',
    priceRub: 1490,
    creditsPerCycle: 4500,
    title: 'Start (retired)',
    isActive: false,
  });
  for (const [key, value] of [
    [OFFICIAL_LEG_DAILY_CAP_KEY, 3000],
    [OFFICIAL_LEG_MONTHLY_CAP_KEY, 20000],
  ] as const) {
    await db
      .insert(appSettings)
      .values({ key, value, updatedBy: null })
      .onConflictDoUpdate({ target: appSettings.key, set: { value } });
  }
});

afterEach(async () => {
  await db
    .delete(appSettings)
    .where(inArray(appSettings.key, [OFFICIAL_LEG_DAILY_CAP_KEY, OFFICIAL_LEG_MONTHLY_CAP_KEY]));
});

describe('a job the official leg delivered', () => {
  it('settles at the credits the customer paid, and names the leg that served it', async () => {
    const jobId = await seedOfficialJob();
    const outcome = await runJob({
      jobId,
      log,
      storage: new MemoryStorage(),
      adapterFactory: factoryFor(collapsedOfficialChain(servingOpenRouter())),
    });
    expect(outcome).toBe('succeeded');
    // The chain had exactly one leg. It must still say WHICH leg — the ~2.7x
    // last-resort one, not the 'openrouter' its inner adapter stamps.
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.gatewayUsed).toBe('openrouter-official');
    const row = await legSpendRow(jobId);
    expect(Number(row!.costRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    expect(Number(row!.revenueRub)).toBeCloseTo(50 * (1490 / 4500), 3);
    expect(Number(row!.pendingRub)).toBe(0);
  });

  it('prices the job at the provider own invoice when the response carries one', async () => {
    // `capabilities.officialUsdPerUnit` is one charge copied by hand and never
    // re-checked against a bill. `usage.cost` IS the bill.
    const jobId = await seedOfficialJob();
    await runJob({
      jobId,
      log,
      storage: new MemoryStorage(),
      adapterFactory: factoryFor(
        collapsedOfficialChain(
          servingOpenRouter({ providerCostUsd: 0.4, providerCostComplete: true }),
        ),
      ),
    });
    const row = await legSpendRow(jobId);
    expect(row!.costSource).toBe('invoiced');
    expect(Number(row!.costRub)).toBeCloseTo(0.4 * OFFICIAL_LEG_FX_RUB, 3);
  });
});

describe('a job the official leg was paid for and did not deliver', () => {
  it('counts a response with no usable asset as a full loss', async () => {
    // `NO_ASSET`: the call ran, we were billed, and there was nothing to sell.
    // The old counter, sitting behind a successful settle, recorded nothing.
    const jobId = await seedOfficialJob();
    const outcome = await runJob({
      jobId,
      log,
      storage: new MemoryStorage(),
      adapterFactory: factoryFor(
        collapsedOfficialChain(
          failingOpenRouter(
            new ProviderError({
              code: 'NO_ASSET',
              status: 200,
              retryable: true,
              message: 'image call 1/1 returned no image',
            }),
          ),
        ),
      ),
    });
    expect(outcome).toBe('failed');
    const row = await legSpendRow(jobId);
    expect(Number(row!.costRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    expect(Number(row!.revenueRub)).toBe(0);
    // Terminal, not still-in-flight: the reservation booked the ₽, and the
    // settle is what stops it claiming future headroom as well.
    expect(Number(row!.pendingRub)).toBe(0);
    expect(row!.settledAt).not.toBeNull();
    expect((await readOfficialLegSpend()).dayRub).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
  });

  it('counts a crash AFTER generation — the upload — as a full loss', async () => {
    const storage = new MemoryStorage();
    storage.failOnPut = true;
    const jobId = await seedOfficialJob();
    const outcome = await runJob({
      jobId,
      log,
      storage,
      adapterFactory: factoryFor(collapsedOfficialChain(servingOpenRouter())),
    });
    expect(outcome).toBe('failed');
    const row = await legSpendRow(jobId);
    expect(Number(row!.costRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    expect(Number(row!.revenueRub)).toBe(0);
    expect(Number(row!.pendingRub)).toBe(0);
    expect(row!.settledAt).not.toBeNull();
  });

  it('counts a job the reaper terminated while we were still uploading', async () => {
    // The guarded `running → succeeded` update claims zero rows, `runJob`
    // returns early and drops the objects — and the provider was still paid
    // while the customer was refunded. The old counter's entire body sat behind
    // that claim, so this outcome recorded nothing at all.
    const storage = new MemoryStorage();
    const jobId = await seedOfficialJob();
    storage.onPut = async () => {
      await db
        .update(jobs)
        .set({ status: 'failed', finishedAt: new Date(), errorCode: 'reaped' })
        .where(eq(jobs.id, jobId));
    };
    const outcome = await runJob({
      jobId,
      log,
      storage,
      adapterFactory: factoryFor(collapsedOfficialChain(servingOpenRouter())),
    });
    expect(outcome).toBe('skipped');
    const row = await legSpendRow(jobId);
    expect(Number(row!.costRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    expect(Number(row!.revenueRub)).toBe(0);
    expect(row!.settledAt).not.toBeNull();
  });

  it('gives the budget back for a request the vendor refused outright', async () => {
    // A 401 on a single-image request bills nothing. Booking it anyway would let
    // a wrong API key burn the day's cap in seconds.
    const jobId = await seedOfficialJob();
    await runJob({
      jobId,
      log,
      storage: new MemoryStorage(),
      adapterFactory: factoryFor(
        collapsedOfficialChain(
          failingOpenRouter(
            new ProviderError({
              code: 'HTTP_401',
              status: 401,
              retryable: false,
              message: 'invalid api key',
            }),
          ),
        ),
      ),
    });
    expect(await readOfficialLegSpend()).toEqual({ dayRub: 0, monthRub: 0 });
    expect((await legSpendRow(jobId))!.costSource).toBe('released');
  });
});

describe('a job the leg submitted more than once', () => {
  /** BullMQ hands the same job back after a retryable error; each pass is a new
   *  submit, and a new real charge. */
  async function runAttempt(
    jobId: string,
    adapterFactory: ProviderAdapterFactory,
    attempt: number,
  ) {
    return runJob({
      jobId,
      log,
      storage: new MemoryStorage(),
      adapterFactory,
      attempt,
      maxAttempts: 2,
    });
  }

  it('counts BOTH submits when only the last one comes back with an invoice', async () => {
    // Attempt 1 is billed and returns nothing to sell (`NO_ASSET` is our own
    // 200-status code — the call ran). Attempt 2 succeeds and reports its own
    // `usage.cost`. Settlement priced the job as `cost − pending + invoiced`
    // where `pending` was the ACCUMULATED reservation of every attempt, so one
    // invoice erased both charges: two 25.6264 ₽ bills settled as one.
    const jobId = await seedOfficialJob();
    const factory = factoryFor(
      collapsedOfficialChain(
        scriptedOpenRouter([
          new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: true,
            message: 'billed, and nothing to sell',
          }),
          { providerCostUsd: NANO_BANANA_PRO_4K_USD, providerCostComplete: true },
        ]),
      ),
    );
    await expect(runAttempt(jobId, factory, 0)).rejects.toMatchObject({ code: 'NO_ASSET' });
    expect(await runAttempt(jobId, factory, 1)).toBe('succeeded');
    expect(totalOf(await legSpendRows(jobId))).toBeCloseTo(ONE_4K_IMAGE_RUB * 2, 3);
  });

  it('keeps a billed attempt when a LATER attempt is refused outright', async () => {
    // Attempt 1 ran and was billed. Attempt 2 never reached the vendor (401), so
    // its own reservation goes back — and `releaseOfficialLegSpend` subtracted
    // the job's whole accumulated pending, erasing attempt 1's real 25.6264 ₽
    // and marking the row settled so the terminal settle then no-opped.
    const jobId = await seedOfficialJob();
    const factory = factoryFor(
      collapsedOfficialChain(
        scriptedOpenRouter([
          new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: true,
            message: 'billed, and nothing to sell',
          }),
          new ProviderError({
            code: 'HTTP_401',
            status: 401,
            retryable: false,
            message: 'invalid api key',
          }),
        ]),
      ),
    );
    await expect(runAttempt(jobId, factory, 0)).rejects.toMatchObject({ code: 'NO_ASSET' });
    expect(await runAttempt(jobId, factory, 1)).toBe('failed');
    expect(totalOf(await legSpendRows(jobId))).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    expect((await readOfficialLegSpend()).dayRub).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
  });
});

describe('an invoice is only an invoice when it covers the whole attempt', () => {
  it('does not let one image own cost stand in for a four-image fan-out', async () => {
    // The image path fires one paid call per image and summed `usage.cost ?? 0`
    // across them, so a response set where only ONE call reported a cost still
    // produced a positive subtotal — and that subtotal REPLACED the four-image
    // reservation. 102.5056 ₽ of real spend settled as 25.6264 ₽, and the row
    // then booked the revenue of all four, which can read as profit.
    const jobId = await seedOfficialJob(4);
    const outcome = await runJob({
      jobId,
      log,
      storage: new MemoryStorage(),
      adapterFactory: factoryFor(
        collapsedOfficialChain(
          scriptedOpenRouter([{ providerCostUsd: NANO_BANANA_PRO_4K_USD }], 4),
        ),
      ),
    });
    expect(outcome).toBe('succeeded');
    const rows = await legSpendRows(jobId);
    expect(totalOf(rows)).toBeCloseTo(ONE_4K_IMAGE_RUB * 4, 3);
    expect(rows.every((row) => row.costSource === 'configured')).toBe(true);
  });
});

describe('the reaper finalizes money the runner never got to', () => {
  /** A reservation with no live runner behind it — the worker was killed after
   *  the leg submitted, so nothing in `runJob` will ever settle it. */
  async function orphanReservation(jobId: string): Promise<void> {
    await reserveOfficialLegSpend({
      jobId,
      modelId: 'gemini-3-pro-image',
      rung: '4K',
      units: 1,
      usdPerUnit: NANO_BANANA_PRO_4K_USD,
    });
  }

  it('settles the reservation of a job it reaps out of running', async () => {
    // The existing "reaper wins" spec never kills the worker: it flips the
    // status while the live runner keeps going, and that runner does the
    // settling. A hard worker death has no runner left, and the reaper refunded
    // the customer without ever closing the leg's ₽.
    const jobId = await seedOfficialJob();
    await orphanReservation(jobId);
    await db
      .update(jobs)
      .set({ status: 'running', startedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(jobs.id, jobId));

    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000);

    const [row] = await legSpendRows(jobId);
    expect(row!.settledAt).not.toBeNull();
    expect(Number(row!.pendingRub)).toBe(0);
    expect(Number(row!.costRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
    expect(Number(row!.revenueRub)).toBe(0);
  });

  it('settles a reservation whose own settlement failed and was never retried', async () => {
    // The standalone settle was one awaited transaction with no outbox and no
    // sweep behind it. When it failed, the job was already terminal, so the
    // redelivered `runJob` skipped it and the reservation held its ₽ against the
    // cap until it aged out of the 30-day window.
    const jobId = await seedOfficialJob();
    await orphanReservation(jobId);
    await db
      .update(jobs)
      .set({ status: 'failed', finishedAt: new Date(), errorCode: 'PROVIDER_FAILED' })
      .where(eq(jobs.id, jobId));

    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000);

    const [row] = await legSpendRows(jobId);
    expect(row!.settledAt).not.toBeNull();
    expect(Number(row!.pendingRub)).toBe(0);
    expect(Number(row!.costRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
  });

  it('leaves a reservation alone while its job is still queued for a retry', async () => {
    // A retryable error puts the job back in `queued` with attempt 1's charge
    // still open. That is a live job, not an orphan — settling it here would
    // close a reservation the next attempt is still accounting against.
    const jobId = await seedOfficialJob();
    await orphanReservation(jobId);
    await db
      .update(jobs)
      .set({ status: 'queued', queuedAt: new Date(), startedAt: null })
      .where(eq(jobs.id, jobId));

    await sweepStuckJobs(log, 15 * 60_000, 10 * 60_000);

    const [row] = await legSpendRows(jobId);
    expect(row!.settledAt).toBeNull();
    expect(Number(row!.pendingRub)).toBeCloseTo(ONE_4K_IMAGE_RUB, 3);
  });
});

describe('the budget stops the leg', () => {
  it('refuses to submit once the day cap is gone, and fails the job cleanly', async () => {
    await db
      .insert(appSettings)
      .values({ key: OFFICIAL_LEG_DAILY_CAP_KEY, value: 1, updatedBy: null })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 1 } });
    const jobId = await seedOfficialJob();
    const outcome = await runJob({
      jobId,
      log,
      storage: new MemoryStorage(),
      adapterFactory: factoryFor(collapsedOfficialChain(servingOpenRouter())),
    });
    expect(outcome).toBe('failed');
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.errorCode).toBe('OFFICIAL_LEG_BUDGET_EXHAUSTED');
    expect(await legSpendRow(jobId)).toBeUndefined();
  });
});
