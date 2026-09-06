import { describe, expect, it } from 'vitest';
import { buildOpenRouterVideoBody } from '../src/openrouter-adapter';
import type { WorkflowSpec } from '../src/types';

/**
 * DoD 9 — drift automation (conformance vs INDEPENDENT fixtures). Expected outputs are
 * HAND-COMPUTED from each route contract's declared semantics (NOT read back from the
 * registry), so this genuinely catches serializer↔registry drift: if the OpenRouter
 * body-builder stopped deriving from the contract, these exact values would change.
 * Each probe is chosen where the registry value DIFFERS from what the legacy
 * capability-driven path would emit (snapping, the Fast 720p ceiling, off-menu
 * defaulting), so a regression cannot silently pass.
 */
function spec(
  modelId: string,
  providerModelId: string,
  params: Record<string, unknown>,
): WorkflowSpec {
  return {
    modelId,
    providerModelId,
    providerEndpoint: '/videos',
    kind: 'video',
    prompt: 'conformance probe',
    params,
    referenceAssets: [],
    maxDurationSeconds: 15,
  };
}

interface Probe {
  in: Record<string, unknown>;
  out: { model: string; resolution: string; duration: number; aspect_ratio?: string };
}

const CASES: Array<{ modelId: string; providerModelId: string; probes: Probe[] }> = [
  {
    // Seedance 2.0 (OR primary) → bytedance/seedance-2.0; menu is every integer 4..15.
    modelId: 'seedance-2-0',
    providerModelId: 'seedance-2.0-text-to-video',
    probes: [
      {
        in: { resolution: '1080p', duration_seconds: 7, aspect_ratio: '9:16' },
        out: {
          model: 'bytedance/seedance-2.0',
          resolution: '1080p',
          duration: 7,
          aspect_ratio: '9:16',
        },
      },
      {
        // Off-menu 2160p → the contract default 720p (registry authority).
        in: { resolution: '2160p', duration_seconds: 4 },
        out: { model: 'bytedance/seedance-2.0', resolution: '720p', duration: 4 },
      },
    ],
  },
  {
    // Seedance 2.0 Fast → bytedance/seedance-2.0-fast; NO 1080p ([480p,720p]).
    modelId: 'seedance-2-0-fast',
    providerModelId: 'seedance-2.0-fast-text-to-video',
    probes: [
      {
        // 1080p is off-menu for Fast → forced to the 720p ceiling (the closed legacy leak).
        in: { resolution: '1080p', duration_seconds: 5 },
        out: { model: 'bytedance/seedance-2.0-fast', resolution: '720p', duration: 5 },
      },
      {
        in: { resolution: '480p', duration_seconds: 8, aspect_ratio: '16:9' },
        out: {
          model: 'bytedance/seedance-2.0-fast',
          resolution: '480p',
          duration: 8,
          aspect_ratio: '16:9',
        },
      },
    ],
  },
  {
    // Wan 2.7 (OR fallback) → alibaba/wan-2.7; snaps duration to [4,6,8,10].
    modelId: 'wan-2-7',
    providerModelId: 'alibaba/wan-2.7',
    probes: [
      {
        // 7 snaps DOWN to 6 (the menu) — legacy would have emitted 7.
        in: { resolution: '720p', duration_seconds: 7, aspect_ratio: '1:1' },
        out: { model: 'alibaba/wan-2.7', resolution: '720p', duration: 6, aspect_ratio: '1:1' },
      },
      {
        in: { resolution: '1080p', duration_seconds: 4 },
        out: { model: 'alibaba/wan-2.7', resolution: '1080p', duration: 4 },
      },
    ],
  },
];

describe('OpenRouter serializer conforms to the registry contract (independent fixtures)', () => {
  for (const { modelId, providerModelId, probes } of CASES) {
    describe(modelId, () => {
      for (const probe of probes) {
        it(`${JSON.stringify(probe.in)} → contract-exact body`, () => {
          const body = buildOpenRouterVideoBody(spec(modelId, providerModelId, probe.in));
          expect(body['model']).toBe(probe.out.model);
          expect(body['resolution']).toBe(probe.out.resolution);
          expect(body['duration']).toBe(probe.out.duration);
          if (probe.out.aspect_ratio !== undefined) {
            expect(body['aspect_ratio']).toBe(probe.out.aspect_ratio);
          }
        });
      }
    });
  }
});
