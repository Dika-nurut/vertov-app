# Compute topology & scaling (INF-10 / INF-11 / INF-12)

The stateful tiers move to managed cloud (Postgres/Redis/Object Storage); the
compute tiers stay as containers/VMs but become **stateless and replaceable**.

## INF-10 — separate web / api / worker services

Deploy three independent services, each scaling on its own:

| Service | Process                     | Scales on           | Notes                                              |
| ------- | --------------------------- | ------------------- | -------------------------------------------------- |
| web     | `next start` :3000          | request concurrency | SSR; stateless                                     |
| api     | `node dist/server.js` :4000 | request concurrency | Fastify; holds the PG pool + metrics Redis         |
| worker  | `node dist/index.js`        | queue depth / CPU   | ffmpeg + BullMQ; **CPU-heavy — isolate from data** |

**Why separate:** a render/CPU spike on the worker must not starve the DB or the
API event loop (the #3 headline risk). Put the worker on its own instance group.

**Horizontal worker scale is correctness-safe (verified in code), so you can run
N workers:**

- All periodic pollers are **Redis leader-elected** (`SET NX PX`): generation
  reaper (`seed:reaper:leader`), render reaper (`seed:render-reaper:leader`),
  gallery reaper (`seed:gallery-reaper:leader`), subscription cycle
  (`seed:sub-cycle:leader`) — only one instance runs each tick.
- The credit **outbox** drainer is idempotent: the success UPDATE is guarded by
  `processed_at IS NULL`, so multiple drainers racing a row bump `attempts` once
  and only one flips `processed_at` (`packages/credits/src/outbox.ts`).
- BullMQ workers are designed for N concurrent consumers.

This protects the security register's reaper↔runner invariants under scale-out.

## INF-11 — connection pooling

Each app instance opens up to `PG_POOL_MAX` (default 20) connections. `N instances
× PG_POOL_MAX` must stay under managed-PG `max_connections`. Front Postgres with
a pooler so instance count is decoupled from DB connection limits:

- **Preferred:** the managed provider's connection pooler (Yandex Managed PG ships
  a built-in pooler endpoint) in **transaction** pooling mode.
- **Alternative:** PgBouncer sidecar, `pool_mode = transaction`.
- Caveat: transaction pooling disallows session-level features (advisory locks,
  `SET` that must persist, prepared statements across statements). The app uses
  short transactions + per-tick Redis locks (not PG session locks), so it's
  compatible. Keep `PG_POOL_MAX` modest (e.g. 10) when behind a transaction pooler.

Sizing example: pooler `max_connections` 200 → `default_pool_size` per db sized so
`web + api + worker` instance fan-out fits with headroom for the backup/cron user.

## INF-12 — graceful drain on deploy / scale-in ✅ coded + tested

On SIGTERM/SIGINT the worker:

1. stops the leader-elected pollers + outbox drainer,
2. closes the metrics server,
3. **drains BullMQ workers** — waits for the in-flight job to finish — bounded by
   `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 25s); on timeout it force-closes and the
   **reapers + outbox recover** anything stranded (`apps/worker/src/shutdown.ts`,
   unit-tested in `shutdown.test.ts`),
4. only then closes the producer queues, Redis connection, and PG pool.

**Set the orchestrator grace period LONGER than `SHUTDOWN_DRAIN_TIMEOUT_MS`** so
our clean force-close fires before SIGKILL:

- docker: `stop_grace_period: 30s` (compose) / `docker stop -t 30`
- k8s: `terminationGracePeriodSeconds: 30`

A rolling restart therefore never strands a job or a credit reservation: jobs that
finish in-window complete; jobs cut off by the deadline are re-reaped.

## Status

- **INF-10:** 🚧 — topology + horizontal-scale safety documented & verified in
  code. Flips to ✅ when deployed as separate services and the load smoke (INF-21)
  shows a render spike doesn't degrade API/DB latency.
- **INF-11:** 🚧 — pooling approach + sizing documented. Flips to ✅ when app
  instances scale without hitting PG `max_connections` under the load smoke.
- **INF-12:** ✅ coded + unit-tested + deploy-failure contract-tested + documented;
  a live rolling-restart drill is folded into the load smoke (INF-21).

## Support attachments

The support form stores files in the private `seed-support-attachments` bucket
under `support/`. Managed object storage must provision that bucket and a
one-day lifecycle rule for the `support/` prefix before the API is deployed.
The API and worker require only data-plane access: API `PutObject`/`DeleteObject`,
worker `GetObject`/`DeleteObject`. Keep `SUPPORT_ATTACHMENT_BOOTSTRAP` unset or
`false` in production; `true` is only for an explicitly bootstrapped local MinIO.
