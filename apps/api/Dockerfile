# Seed API (Fastify) — INF-15. Build context = repo root:
#   docker build -f apps/api/Dockerfile -t seed-api .
#
# Runtime is tsx (the workspace packages export TS source via their `main`, e.g.
# @seed/db -> src/index.ts, so they are NOT pre-compiled; this matches how the
# app actually runs). A future optimization is an esbuild bundle to drop tsx +
# dev deps from the runtime image.
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
# Whole workspace install — the lockfile is the cache key; --frozen-lockfile
# guarantees the same tree as CI (reproducibility, INF-15).
COPY . .
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
ARG SEED_COMMIT_SHA
# ffmpeg + ffprobe: the studio's INTERACTIVE timeline runs in the API process —
# /v1/studio/peaks (audio waveform) and /v1/studio/filmstrip (video thumbnails)
# spawn ffmpeg/ffprobe directly (low-latency, separate from the worker render
# farm). Without this the editor's waveform/filmstrip 502 with `spawn ffmpeg ENOENT`.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV SEED_COMMIT_SHA=${SEED_COMMIT_SHA}
COPY infra/compute/russian-trusted-root-ca.crt /usr/local/share/ca-certificates/russian-trusted-root-ca.crt
COPY --chown=node:node --from=deps /app /app
# Bake pnpm into the image. `corepack enable` only installs a SHIM: the first
# `pnpm` call downloads the pinned version from registry.npmjs.org at RUNTIME,
# so container start — and the deploy's migration gate, which runs
# `compose run --rm api pnpm db:migrate` — silently depend on npmjs being
# reachable from the production VM. On 2026-07-28 it was not, and the deploy
# aborted at that gate. `prepare` with no spec reads `packageManager` from the
# workspace package.json, so the pin stays in one place. COREPACK_HOME is a
# shared path (the default is per-user, and this image drops to `node` below).
ENV COREPACK_HOME=/opt/corepack
RUN corepack prepare --activate && chmod -R a+rX /opt/corepack
EXPOSE 4000 4001
# Liveness for the orchestrator; readiness (/ready) is polled by the LB/INF-16.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Audit M5 (DS-0002): drop root. The slim image ships an unprivileged `node`
# (uid 1000); /app is chowned to it on COPY so tsx can read the workspace.
USER node
CMD ["pnpm", "--filter", "@seed/api", "exec", "tsx", "src/server.ts"]
