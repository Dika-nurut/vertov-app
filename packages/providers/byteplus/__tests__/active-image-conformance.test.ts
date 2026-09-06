import { describe, expect, it } from 'vitest';
import { seedModels } from '../../../db/seed/models';
import { buildKieImageBody, buildOpenRouterImageBody, type WorkflowSpec } from '../src/index';

describe('BRD-3 active image catalog → provider-body conformance', () => {
  const activeImages = seedModels.filter(
    (model) => model.isActive && (model.kind === 'image' || model.kind === 'image-edit'),
  );

  it('maps every active row without inventing unsupported image controls', () => {
    expect(activeImages).toHaveLength(10);

    for (const model of activeImages) {
      const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
      const aspects = capabilities['aspect_ratios'] as string[];
      const resolutions = capabilities['resolutions'] as string[];
      const maxRefs = capabilities['maxRefs'] as number;
      const params: Record<string, unknown> = { n: 2 };
      if (aspects.length > 0) params['aspect_ratio'] = aspects[0];
      if (resolutions.length > 0) params['resolution'] = resolutions[0];
      if (maxRefs > 0) params['imageUrls'] = ['https://assets.test/reference.png'];

      const spec: WorkflowSpec = {
        modelId: model.id,
        providerModelId: model.providerModelId,
        providerEndpoint: model.providerEndpoint,
        kind: model.kind,
        prompt: 'catalog conformance',
        params,
        referenceAssets: [],
        maxDurationSeconds: model.maxDurationSeconds,
        capabilities,
      };

      // The routed gateway, not just `capabilities.forceGateway`. The top-level
      // `gatewayOverride` column is the other half of routing (jobs-routes precedence is
      // override → slash-form → forceGateway), and reading only the capability bag sent
      // flux-2-pro down the OpenRouter branch even though kie has been its charged
      // primary since the owner ruling of 2026-08-04. The test was checking the wrong
      // adapter for that model, which is why it only noticed when the OpenRouter reserve
      // stopped carrying a rung it never had a control for.
      // O-1 (2026-09-02): the nano-banana image rows moved from the
      // `forceGateway:'nanobanana'` alias to gatewayOverride:'laozhang' +
      // fallbackGateway:'kie'. The laozhang primary speaks the SAME
      // Gemini/OpenAI body shapes the chain adapters serialize (the chain
      // delegates per model), asserted here against the kie body builder that
      // models the shared shape.
      const gateway = model.gatewayOverride ?? capabilities['forceGateway'];
      const kieServing = gateway === 'kie' || gateway === 'nanobanana' || gateway === 'laozhang';
      if (kieServing) {
        const body = buildKieImageBody(spec);
        const input = body['input'] as Record<string, unknown>;
        expect(input['aspect_ratio'], `${model.id}: aspect`).toBe(aspects[0]);
        // kie seedream rows map resolution onto the `quality` enum (no
        // `resolution` field exists in their schema); nano-banana rows pass
        // `resolution` straight through. A tier is expected only when the row
        // declares resolutions — banana variants that drop the lever by design
        // (base/lite) declare none and must send nothing.
        const tier = input['resolution'] ?? input['quality'];
        if (resolutions.length > 0) {
          expect(tier, `${model.id}: resolution tier`).toBeTruthy();
        } else {
          expect(tier, `${model.id}: no resolution lever`).toBeUndefined();
        }
        const refs = input['image_input'] ?? input['image_urls'] ?? input['input_urls'];
        expect(Boolean(refs), `${model.id}: references`).toBe(maxRefs > 0);
      } else {
        const body = buildOpenRouterImageBody(spec);
        expect(body['aspect_ratio'], `${model.id}: aspect`).toBe(aspects[0]);
        expect(body['resolution'], `${model.id}: resolution`).toBe(
          resolutions.length > 0 ? resolutions[0] : undefined,
        );
        expect(Boolean(body['input_references']), `${model.id}: references`).toBe(maxRefs > 0);
        // One-output calls are deliberate; the adapter fans out requested n so
        // models whose native maximum is one still deliver the billed count.
        expect(body['n'], `${model.id}: native call count`).toBe(1);
      }
    }
  });
});
