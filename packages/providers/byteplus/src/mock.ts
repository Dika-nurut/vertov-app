import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ProviderError,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';
import { renderStubPreviewSvg, squareSizeFromParams } from './stub-art';

/**
 * Scriptable mock gateway (T1 of the testing-harness campaign).
 *
 * Unlike {@link StubBytePlusAdapter} — which only ever models the happy path —
 * the mock gateway lets a test drive ANY of the real provider outcomes through
 * a per-job directive, emitting the SAME `ProviderError` shapes the live
 * adapters classify (see `evolink-adapter.ts` / `openrouter-adapter.ts`). That
 * way the worker's reserve/refund, retry, status, SSE-event and board-patch
 * paths all execute offline, deterministically, at zero credit spend.
 *
 * The directive rides on `spec.params.__mock`; absent a directive the adapter
 * is back-compatible with the stub (happy path). A process-wide default can be
 * injected (constructor or `MOCK_GATEWAY_OUTCOME` env) so a whole-suite run can
 * arm an outcome without touching every workflow row.
 */

export type MockOutcome =
  | 'success'
  | 'moderation'
  | 'insufficient'
  | 'timeout'
  | 'retry'
  | 'noasset';

export interface MockDirective {
  outcome?: MockOutcome;
  /** Force the produced asset kind regardless of model kind (success only). */
  assetKind?: 'image' | 'video';
  /** Carried into result meta so editor-side consumers can assert duration. */
  durationSec?: number;
  resolution?: string;
  /** Batch size for image success (clamped 1..4), honoured like the stub. */
  n?: number;
  seed?: number;
  /** M-1: stamp `nsfw:true` on every produced asset (image success), to drive
   * the worker's provider-NSFW-flag → gallery-tag path in tests. */
  nsfw?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(here, '../fixtures');

async function loadFixture(name: string): Promise<GenerationResult> {
  const raw = await readFile(resolve(FIXTURES_DIR, name), 'utf8');
  const data = JSON.parse(raw) as {
    assets: { contentType: string; extension: string; base64: string }[];
    meta?: Record<string, unknown>;
  };
  return {
    assets: data.assets.map((a) => ({
      bytes: Buffer.from(a.base64, 'base64'),
      contentType: a.contentType,
      extension: a.extension,
    })),
    ...(data.meta !== undefined ? { meta: data.meta } : {}),
  };
}

/**
 * Coerce an unknown `spec.params.__mock` value into a directive. Strings are
 * treated as a bare outcome (`__mock: 'moderation'`); objects are read field by
 * field. Anything else → empty directive (happy path).
 */
export function parseMockDirective(raw: unknown): MockDirective {
  if (typeof raw === 'string') return { outcome: raw as MockOutcome };
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const d: MockDirective = {};
  if (typeof o['outcome'] === 'string') d.outcome = o['outcome'] as MockOutcome;
  if (o['assetKind'] === 'image' || o['assetKind'] === 'video') d.assetKind = o['assetKind'];
  if (typeof o['durationSec'] === 'number') d.durationSec = o['durationSec'];
  if (typeof o['resolution'] === 'string') d.resolution = o['resolution'];
  if (typeof o['n'] === 'number') d.n = o['n'];
  if (typeof o['seed'] === 'number') d.seed = o['seed'];
  if (typeof o['nsfw'] === 'boolean') d.nsfw = o['nsfw'];
  return d;
}

/** Phase a given outcome resolves in — mirrors where the live adapters throw. */
export type MockPhase = 'submit' | 'poll' | 'none';

const SUBMIT_OUTCOMES = new Set<MockOutcome>(['moderation', 'insufficient']);
const POLL_OUTCOMES = new Set<MockOutcome>(['timeout', 'retry', 'noasset']);

export function mockPhaseFor(outcome: MockOutcome | undefined): MockPhase {
  if (!outcome || outcome === 'success') return 'none';
  if (SUBMIT_OUTCOMES.has(outcome)) return 'submit';
  if (POLL_OUTCOMES.has(outcome)) return 'poll';
  return 'none';
}

/**
 * Pure decision logic: map an outcome to the EXACT `ProviderError` the live
 * gateways produce (code / status / retryable), or `null` for success. Tested
 * in isolation — no network, no I/O.
 */
export function mockErrorFor(outcome: MockOutcome | undefined): ProviderError | null {
  switch (outcome) {
    case 'moderation':
      // openrouter-adapter.ts:318 — submit-time embedded 400.
      return new ProviderError({
        code: 'SUBMIT_REJECTED',
        status: 400,
        retryable: false,
        message: 'InputImageSensitiveContentDetected.PrivacyInformation',
      });
    case 'insufficient':
      // classify(402, `HTTP_402`, ...) — non-retryable, drives the refund path.
      return new ProviderError({
        code: 'HTTP_402',
        status: 402,
        retryable: false,
        message: 'insufficient credits',
      });
    case 'timeout':
      // evolink-adapter.ts:233 — poll ceiling, non-retryable terminal timeout.
      return new ProviderError({
        code: 'TIMEOUT',
        status: 408,
        retryable: false,
        message: 'task did not finish within poll ceiling',
      });
    case 'retry':
      // evolink-adapter.ts:187 — consecutive poll failures, RETRYABLE.
      return new ProviderError({
        code: 'POLL_UNREACHABLE',
        status: 503,
        retryable: true,
        message: 'consecutive poll errors; upstream unreachable',
      });
    case 'noasset':
      // evolink-adapter.ts:202 — completed but empty, non-retryable.
      return new ProviderError({
        code: 'NO_ASSET',
        status: 200,
        retryable: false,
        message: 'task completed with no result url',
      });
    case 'success':
    case undefined:
    default:
      return null;
  }
}

/** A raw-media clip the mock can serve for a video success (T2 corpus). */
export interface MockCorpusClip {
  durationSec: number;
  /** Absolute path to a raw .mp4 on disk. */
  path: string;
  contentType?: string;
  extension?: string;
}

export interface MockGatewayOptions {
  /** Default directive applied when a job carries none. */
  defaultDirective?: MockDirective;
  /** Optional alternate JSON fixture dir (default: the package fixtures). */
  fixturesDir?: string;
  /**
   * T2 media corpus: real ffmpeg clips served (raw bytes) for video success.
   * When set, a video success picks the clip whose duration is nearest the
   * requested `durationSec`, so editor-side consumers get predictable media.
   * Unset ⇒ the frozen seedance JSON fixture (back-compat).
   */
  corpus?: MockCorpusClip[];
}

export class MockGatewayAdapter implements ProviderAdapter {
  private readonly defaults: MockDirective;
  private readonly fixturesDir: string;
  private readonly corpus: MockCorpusClip[];

  constructor(opts: MockGatewayOptions = {}) {
    const envOutcome = (process.env['MOCK_GATEWAY_OUTCOME'] ?? '').trim();
    this.defaults = {
      ...(envOutcome ? { outcome: envOutcome as MockOutcome } : {}),
      ...opts.defaultDirective,
    };
    this.fixturesDir = opts.fixturesDir ?? FIXTURES_DIR;
    this.corpus = opts.corpus ?? [];
  }

  private directiveFor(spec: WorkflowSpec): MockDirective {
    return { ...this.defaults, ...parseMockDirective(spec.params['__mock']) };
  }

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind === 'voice') throw new Error(`mock: unsupported kind ${spec.kind}`);
    const directive = this.directiveFor(spec);
    const outcome = directive.outcome ?? 'success';

    if (mockPhaseFor(outcome) === 'submit') {
      throw mockErrorFor(outcome);
    }

    const assetKind = directive.assetKind ?? (spec.kind === 'video' ? 'video' : 'image');

    // Happy-path images resolve synchronously (inline), exactly like the stub,
    // so the result grid / «Вариации» flows run with zero polling.
    if (outcome === 'success' && assetKind === 'image') {
      return {
        providerJobId: `mock-img-${this.tag(spec)}`,
        gateway: 'mock',
        inlineResult: this.imageResult(spec, directive),
      };
    }
    // Video success + every poll-phase outcome resolve in awaitResult.
    return { providerJobId: `mock-${assetKind}-${this.tag(spec)}`, gateway: 'mock' };
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    if (handle.inlineResult) return handle.inlineResult;
    const directive = this.directiveFor(spec);
    const outcome = directive.outcome ?? 'success';

    if (mockPhaseFor(outcome) === 'poll') {
      throw mockErrorFor(outcome);
    }

    const assetKind = directive.assetKind ?? (spec.kind === 'video' ? 'video' : 'image');
    if (assetKind === 'image') return this.imageResult(spec, directive);

    // Brief settle to mimic the poll round-trip without slowing the suite.
    await new Promise((r) => setTimeout(r, 5));
    const served = await this.videoSuccess(directive);
    // Surface the directive's intent in meta so editor-side consumers can
    // assert the duration/resolution they asked for.
    return {
      assets: served.assets,
      meta: {
        ...(served.meta ?? {}),
        mock: true,
        ...(served.servedClip ? { servedClip: served.servedClip } : {}),
        ...(directive.durationSec !== undefined ? { durationSec: directive.durationSec } : {}),
        ...(directive.resolution !== undefined ? { resolution: directive.resolution } : {}),
      },
    };
  }

  /** Deterministic per-spec id fragment (no Date.now → reproducible). */
  private tag(spec: WorkflowSpec): string {
    let h = 0;
    const key = `${spec.modelId}|${spec.prompt}|${JSON.stringify(spec.params['seed'] ?? '')}`;
    for (let i = 0; i < key.length; i += 1) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  private imageResult(spec: WorkflowSpec, directive: MockDirective): GenerationResult {
    const rawN = directive.n ?? Number(spec.params['n']);
    const n = Math.max(1, Math.min(Number.isFinite(rawN) ? Math.round(rawN) : 1, 4));
    const seedParam = directive.seed ?? spec.params['seed'];
    return {
      assets: Array.from({ length: n }, (_, i) => {
        const svg = renderStubPreviewSvg({
          prompt: spec.prompt,
          modelLabel: spec.modelId.replace(/-/g, ' '),
          size: squareSizeFromParams(spec.params),
          variant: `${typeof seedParam === 'number' ? seedParam : ''}:${i}`,
        });
        return {
          bytes: Buffer.from(svg, 'utf8'),
          contentType: 'image/svg+xml',
          extension: 'svg',
          ...(directive.nsfw === true ? { nsfw: true } : {}),
        };
      }),
      meta: { mock: true },
    };
  }

  /**
   * Resolve a video success to real bytes. With a T2 corpus injected, serve
   * the clip whose duration is nearest the requested `durationSec` (raw mp4
   * read from disk). Without one, fall back to the frozen seedance JSON
   * fixture so the mock stays usable with zero wiring.
   */
  private async videoSuccess(
    directive: MockDirective,
  ): Promise<GenerationResult & { servedClip?: string }> {
    if (this.corpus.length > 0) {
      const want = directive.durationSec ?? Infinity;
      const pick = this.corpus.reduce((best, c) =>
        Math.abs(c.durationSec - want) < Math.abs(best.durationSec - want) ? c : best,
      );
      const bytes = await readFile(pick.path);
      return {
        assets: [
          {
            bytes,
            contentType: pick.contentType ?? 'video/mp4',
            extension: pick.extension ?? 'mp4',
          },
        ],
        servedClip: pick.path,
      };
    }
    return this.loadFixtureFrom('seedance-success.json');
  }

  private async loadFixtureFrom(name: string): Promise<GenerationResult> {
    if (this.fixturesDir === FIXTURES_DIR) return loadFixture(name);
    const raw = await readFile(resolve(this.fixturesDir, name), 'utf8');
    const data = JSON.parse(raw) as {
      assets: { contentType: string; extension: string; base64: string }[];
      meta?: Record<string, unknown>;
    };
    return {
      assets: data.assets.map((a) => ({
        bytes: Buffer.from(a.base64, 'base64'),
        contentType: a.contentType,
        extension: a.extension,
      })),
      ...(data.meta !== undefined ? { meta: data.meta } : {}),
    };
  }
}
