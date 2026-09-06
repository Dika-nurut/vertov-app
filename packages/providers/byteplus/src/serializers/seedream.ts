import { seedreamParamsSchema, type WorkflowSpec } from '../types';

export interface SeedreamRequestBody {
  model: string;
  prompt: string;
  size: string;
  n: number;
  seed?: number;
  guidance_scale?: number;
  image?: string[];
}

export function serializeSeedream(spec: WorkflowSpec): SeedreamRequestBody {
  if (spec.kind !== 'image' && spec.kind !== 'image-edit') {
    throw new Error(`serializeSeedream called on kind=${spec.kind}`);
  }
  const p = seedreamParamsSchema.parse(spec.params);
  const body: SeedreamRequestBody = {
    model: spec.providerModelId,
    prompt: spec.prompt,
    size: p.size,
    n: p.n,
  };
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.guidance_scale !== undefined) body.guidance_scale = p.guidance_scale;
  if (spec.kind === 'image-edit' && spec.referenceAssets.length > 0) {
    body.image = spec.referenceAssets;
  }
  return body;
}
