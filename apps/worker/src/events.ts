import IORedis from 'ioredis';
import { redisTlsOptions } from '@seed/credits';

/**
 * Job status events over Redis pub/sub. The API holds one subscriber and
 * fans messages out to per-user SSE connections (GET /v1/jobs/events), so
 * the web client learns about queued→running→succeeded/failed transitions
 * without hammering GET /v1/jobs/:id every 1.5s.
 *
 * Fire-and-forget by design: pub/sub is a latency optimisation layered on
 * top of the DB status writes — a dropped message only means the client
 * falls back to its polling refresh.
 */
export const JOB_EVENTS_CHANNEL = 'jobs:events';

export interface JobEvent {
  userId: string;
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  /** 'generation' (jobs table) or 'studio' (studio_renders table). */
  source: 'generation' | 'studio';
  /**
   * Optional fine-grained progress within `running` (studio render stages:
   * probing | normalizing | composing | uploading). Purely a latency-layer
   * hint for the UI; the coarse `status` stays the source of truth.
   */
  stage?: string;
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

let publisher: IORedis | null = null;

function getPublisher(): IORedis {
  if (!publisher) {
    publisher = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      ...redisTlsOptions(REDIS_URL),
    });
    // Never let a Redis blip take the worker down — errors are logged by
    // the caller's catch; here we just need a handler so ioredis doesn't
    // throw an unhandled 'error' event.
    publisher.on('error', () => {});
  }
  return publisher;
}

export function publishJobEvent(event: JobEvent): void {
  void getPublisher()
    .publish(JOB_EVENTS_CHANNEL, JSON.stringify(event))
    .catch(() => {});
}

export async function closeEventPublisher(): Promise<void> {
  if (publisher) {
    await publisher.quit().catch(() => {});
    publisher = null;
  }
}
