import { seedanceParamsSchema, workflowFrameImages, type WorkflowSpec } from '../types';

export interface SeedanceRequestBody {
  model: string;
  prompt: string;
  duration_seconds: number;
  resolution: string;
  aspect_ratio: string;
  seed?: number;
  image_url?: string;
}

export function serializeSeedance(spec: WorkflowSpec): SeedanceRequestBody {
  if (spec.kind !== 'video') {
    throw new Error(`serializeSeedance called on kind=${spec.kind}`);
  }
  const p = seedanceParamsSchema.parse(spec.params);
  const maxDur = spec.maxDurationSeconds ?? 10;
  const duration = Math.min(p.duration_seconds, maxDur);
  const body: SeedanceRequestBody = {
    model: spec.providerModelId,
    prompt: spec.prompt,
    duration_seconds: duration,
    resolution: p.resolution,
    aspect_ratio: p.aspect_ratio,
  };
  if (p.seed !== undefined) body.seed = p.seed;
  const firstFrame = workflowFrameImages(spec).find((frame) => frame.role === 'first');
  if (firstFrame) body.image_url = firstFrame.url;
  return body;
}
