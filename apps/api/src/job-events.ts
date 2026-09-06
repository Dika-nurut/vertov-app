import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import IORedis from 'ioredis';
import { redisTlsOptions } from '@seed/credits';

/**
 * SSE bridge for job status updates (GET /v1/jobs/events).
 *
 * The worker publishes {userId, jobId, status, source} onto the
 * `jobs:events` Redis channel on every status transition (see
 * apps/worker/src/events.ts). One shared subscriber here fans messages
 * out to the per-user SSE connections, so N open tabs cost one Redis
 * subscription total — not one per tab.
 *
 * This is a latency layer over the DB, not a source of truth: clients
 * keep a slow polling fallback, and on any terminal event they re-fetch
 * GET /v1/jobs/:id for the full payload (assets, errors, credits).
 */
const JOB_EVENTS_CHANNEL = 'jobs:events';
const HEARTBEAT_MS = 25_000;

interface JobEvent {
  userId: string;
  jobId: string;
  status: string;
  source: string;
  /** Optional render stage hint (studio: probing|normalizing|composing|uploading). */
  stage?: string;
}

type SessionGuard = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

export function setupJobEventsRoute(
  app: FastifyInstance,
  requireSession: SessionGuard,
  redisUrl: string,
): { close: () => Promise<void> } {
  const clients = new Map<string, Set<NodeJS.WritableStream>>();

  const subscriber = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    ...redisTlsOptions(redisUrl),
  });
  subscriber.on('error', (err) => app.log.error({ err }, 'job-events subscriber error'));
  void subscriber.subscribe(JOB_EVENTS_CHANNEL).catch((err) => {
    app.log.error({ err }, 'job-events subscribe failed');
  });
  subscriber.on('message', (_channel, message) => {
    let event: JobEvent;
    try {
      event = JSON.parse(message) as JobEvent;
    } catch {
      return;
    }
    const sinks = clients.get(event.userId);
    if (!sinks || sinks.size === 0) return;
    const frame = `event: job\ndata: ${JSON.stringify({
      jobId: event.jobId,
      status: event.status,
      source: event.source,
      ...(event.stage ? { stage: event.stage } : {}),
    })}\n\n`;
    for (const sink of sinks) {
      try {
        sink.write(frame);
      } catch {
        sinks.delete(sink);
      }
    }
  });

  app.get('/v1/jobs/events', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const userId = session.user.id;

    // Carry over headers already negotiated by plugins (CORS allow-origin /
    // allow-credentials, x-request-id) — hijacking bypasses Fastify's send
    // path, so anything not copied here is lost.
    const negotiated: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) {
      if (v !== undefined) negotiated[k] = v as string | number | string[];
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      ...negotiated,
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable proxy buffering (nginx/caddy) so events flush immediately.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: 5000\n\n`);

    let sinks = clients.get(userId);
    if (!sinks) {
      sinks = new Set();
      clients.set(userId, sinks);
    }
    sinks.add(reply.raw);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: hb\n\n`);
      } catch {
        cleanup();
      }
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      const set = clients.get(userId);
      if (set) {
        set.delete(reply.raw);
        if (set.size === 0) clients.delete(userId);
      }
    };
    req.raw.on('close', cleanup);
  });

  return {
    close: async () => {
      for (const sinks of clients.values()) {
        for (const sink of sinks) {
          try {
            (sink as NodeJS.WritableStream & { end: () => void }).end();
          } catch {
            // already gone
          }
        }
      }
      clients.clear();
      await subscriber.quit().catch(() => {});
    },
  };
}
