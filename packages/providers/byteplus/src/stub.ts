import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';
import { renderStubPreviewSvg, squareSizeFromParams } from './stub-art';

interface FixtureFile {
  assets: { contentType: string; extension: string; base64: string }[];
  meta?: Record<string, unknown>;
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(here, '../fixtures');

async function loadFixture(name: string): Promise<GenerationResult> {
  const raw = await readFile(resolve(FIXTURES_DIR, name), 'utf8');
  const data = JSON.parse(raw) as FixtureFile;
  return {
    assets: data.assets.map((a) => ({
      bytes: Buffer.from(a.base64, 'base64'),
      contentType: a.contentType,
      extension: a.extension,
    })),
    ...(data.meta !== undefined ? { meta: data.meta } : {}),
  };
}

export class StubBytePlusAdapter implements ProviderAdapter {
  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind === 'image' || spec.kind === 'image-edit') {
      // Synthesize a deterministic, prompt-derived SVG preview so every distinct
      // prompt yields a distinct (clearly-labelled "превью · стаб") image, instead
      // of the single frozen fixture. Replaced by real output when BYTEPLUS_MODE=live.
      // Honor n (batch) and seed so the result grid / «Вариации» flows are
      // exercisable end-to-end in stub mode: each asset hashes differently.
      const rawN = Number(spec.params['n']);
      const n = Math.max(1, Math.min(Number.isFinite(rawN) ? Math.round(rawN) : 1, 4));
      const seedParam = spec.params['seed'];
      const inlineResult: GenerationResult = {
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
          };
        }),
      };
      return {
        providerJobId: `stub-img-${Date.now().toString(36)}`,
        gateway: 'stub',
        inlineResult,
      };
    }
    if (spec.kind === 'video') {
      // Pretend the video task was accepted; awaitResult will resolve immediately.
      return { providerJobId: `stub-vid-${Date.now().toString(36)}`, gateway: 'stub' };
    }
    throw new Error(`stub: unsupported kind ${spec.kind}`);
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    if (handle.inlineResult) return handle.inlineResult;
    if (spec.kind === 'video') {
      // Brief delay to simulate the polling round-trip without making tests slow.
      await new Promise((r) => setTimeout(r, 10));
      return loadFixture('seedance-success.json');
    }
    throw new Error(`stub: no awaitResult path for kind ${spec.kind}`);
  }
}
