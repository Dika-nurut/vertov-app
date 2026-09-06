import { BytePlusClient } from './client';
import { serializeSeedance } from './serializers/seedance';
import { serializeSeedream } from './serializers/seedream';
import {
  ProviderError,
  type GenerationAsset,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';
import { extensionFromContentType } from './adapter-helpers';

const VIDEO_POLL_CEILING_MS = 180_000;
const VIDEO_POLL_BACKOFF_MS = [3_000, 5_000, 10_000, 15_000] as const;

export class BytePlusAdapter implements ProviderAdapter {
  constructor(private readonly client: BytePlusClient) {}

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    if (spec.kind === 'image' || spec.kind === 'image-edit') {
      const body = serializeSeedream(spec);
      const res = await this.client.createImage(spec.providerEndpoint, body);
      const assets = await Promise.all(
        res.data.map(async (d): Promise<GenerationAsset> => {
          const fetched = await this.client.fetchAsset(d.url);
          return {
            bytes: fetched.bytes,
            contentType: fetched.contentType,
            extension: extensionFromContentType(fetched.contentType),
          };
        }),
      );
      const inlineResult: GenerationResult = { assets };
      if (res.usage) {
        inlineResult.meta = {
          providerUsage: res.usage,
          providerCostComplete: false,
          providerCostSource: 'byteplus.usage.unresolved',
        };
      }
      return {
        providerJobId: `sync-${Date.now().toString(36)}`,
        gateway: 'evolink',
        inlineResult,
      };
    }
    if (spec.kind === 'video') {
      const body = serializeSeedance(spec);
      const task = await this.client.createVideoTask(spec.providerEndpoint, body);
      // BytePlus direct is the same `evolink` gateway family in the registry
      // (makeEvolinkAdapter picks Evolink vs BytePlus by base URL), so resume
      // binds through getAdapter('evolink').
      return { providerJobId: task.id, gateway: 'evolink' };
    }
    throw new Error(`unsupported kind: ${spec.kind}`);
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    if (handle.inlineResult) return handle.inlineResult;
    if (spec.kind !== 'video') {
      throw new Error(`no inline result for kind=${spec.kind} and not video`);
    }
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < VIDEO_POLL_CEILING_MS) {
      const wait = VIDEO_POLL_BACKOFF_MS[Math.min(attempt, VIDEO_POLL_BACKOFF_MS.length - 1)]!;
      await new Promise((r) => setTimeout(r, wait));
      attempt += 1;
      const task = await this.client.getVideoTask(spec.providerEndpoint, handle.providerJobId);
      if (task.status === 'succeeded') {
        const url = task.content?.video_url;
        if (!url) {
          throw new ProviderError({
            code: 'NO_ASSET',
            status: 200,
            retryable: false,
            message: 'video task succeeded with no video_url',
          });
        }
        const fetched = await this.client.fetchAsset(url);
        return {
          assets: [
            {
              bytes: fetched.bytes,
              contentType: fetched.contentType,
              extension: extensionFromContentType(fetched.contentType),
            },
          ],
        };
      }
      if (task.status === 'failed') {
        throw new ProviderError({
          code: task.error?.code ?? 'PROVIDER_FAILED',
          status: 200,
          retryable: false,
          message: task.error?.message ?? 'video task failed',
        });
      }
    }
    throw new ProviderError({
      code: 'TIMEOUT',
      status: 408,
      retryable: false,
      message: `video task ${handle.providerJobId} did not finish within ${VIDEO_POLL_CEILING_MS}ms`,
    });
  }
}
