import { describe, expect, it, vi } from 'vitest';

import { FallbackChainAdapter } from '../src/fallback-chain-adapter';
import { JournaledAdapter } from '../src/journaled-adapter';
import {
  ProviderError,
  type AttemptJournalPort,
  type ProviderAdapter,
  type WorkflowSpec,
} from '../src/types';

describe('at-most-once submit seam', () => {
  it('does not submit the fallback after an ambiguous primary timeout', async () => {
    const journal = memoryJournal();
    const primary: ProviderAdapter = {
      generate: vi.fn(async () => {
        throw new ProviderError({
          message: 'primary timed out after acceptance',
          code: 'TIMEOUT',
          status: 408,
          retryable: true,
        });
      }),
      awaitResult: vi.fn(),
    };
    const fallback: ProviderAdapter = {
      generate: vi.fn(async () => ({ providerJobId: 'fallback-job' })),
      awaitResult: vi.fn(),
    };

    const chain = new FallbackChainAdapter([
      { name: 'primary', adapter: new JournaledAdapter('primary', primary, journal) },
      { name: 'fallback', adapter: fallback },
    ]);

    let error: unknown;
    try {
      await chain.generate({ jobId: 'job-1' } as WorkflowSpec);
    } catch (caught) {
      error = caught;
    }

    expect(fallback.generate).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ProviderError);
  });

  it('refuses a second submit when acceptance happened before the journal write failed', async () => {
    const journal = memoryJournal({ failAccepted: true });
    const primary: ProviderAdapter = {
      generate: vi.fn(async () => ({ providerJobId: 'primary-job' })),
      awaitResult: vi.fn(),
    };
    const fallbackGenerate = vi.fn(async () => ({ providerJobId: 'fallback-job' }));
    const chain = new FallbackChainAdapter([
      { name: 'primary', adapter: new JournaledAdapter('primary', primary, journal) },
      {
        name: 'fallback',
        adapter: { generate: fallbackGenerate, awaitResult: vi.fn() },
      },
    ]);

    await expect(chain.generate({ jobId: 'job-2' } as WorkflowSpec)).rejects.toMatchObject({
      code: 'AMBIGUOUS_SUBMIT',
    });
    expect(fallbackGenerate).not.toHaveBeenCalled();
  });

  it('retries only the durable accepted write when the provider id was received', async () => {
    const journal = memoryJournal({ failAcceptedOnce: true });
    const primary: ProviderAdapter = {
      generate: vi.fn(async () => ({ providerJobId: 'primary-job' })),
      awaitResult: vi.fn(),
    };
    const adapter = new JournaledAdapter('primary', primary, journal);

    await expect(adapter.generate({ jobId: 'job-3' } as WorkflowSpec)).resolves.toMatchObject({
      providerJobId: 'primary-job',
      attemptId: 'attempt-1',
    });
    expect(primary.generate).toHaveBeenCalledTimes(1);
    expect(journal.recordAccepted).toHaveBeenCalledTimes(2);
  });
});

function memoryJournal(
  options: { failAccepted?: boolean; failAcceptedOnce?: boolean } = {},
): AttemptJournalPort {
  let acceptedCalls = 0;
  return {
    beginAttempt: vi.fn(async () => ({ attemptId: 'attempt-1' })),
    recordAccepted: vi.fn(async () => {
      acceptedCalls += 1;
      if (options.failAccepted || (options.failAcceptedOnce && acceptedCalls === 1)) {
        throw new Error('journal unavailable after acceptance');
      }
    }),
    recordDefinitiveFailure: vi.fn(async () => undefined),
    recordAmbiguous: vi.fn(async () => undefined),
  };
}
