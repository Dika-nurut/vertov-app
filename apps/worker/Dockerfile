# Seed worker (BullMQ + ffmpeg) — INF-15. Build context = repo root:
#   docker build -f apps/worker/Dockerfile -t seed-worker .
#
# CPU-heavy (ffmpeg renders) — deploy on its own instance group, isolated from
# the data tier (INF-10). Runtime is tsx (see apps/api/Dockerfile note).
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
# ffmpeg is the worker's core render dependency.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
# Drain in-flight renders on SIGTERM before SIGKILL (INF-12). Keep the
# orchestrator grace (stop_grace_period / terminationGracePeriodSeconds) > this.
ENV SHUTDOWN_DRAIN_TIMEOUT_MS=25000
COPY infra/compute/russian-trusted-root-ca.crt /usr/local/share/ca-certificates/russian-trusted-root-ca.crt
COPY --chown=node:node --from=deps /app /app
# Bake pnpm — `corepack enable` is only a shim that fetches the pinned version
# from npmjs on first use, so container start would depend on npmjs being
# reachable from the production VM. See apps/api/Dockerfile for the incident.
ENV COREPACK_HOME=/opt/corepack
RUN corepack prepare --activate && chmod -R a+rX /opt/corepack
EXPOSE 4002
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Audit M5 (DS-0002): drop root — the worker shells out to ffmpeg on user media,
# so an ffmpeg/codec bug must not execute as uid 0. ffmpeg was apt-installed
# above as root; runtime drops to the image's unprivileged `node` user.
USER node
CMD ["pnpm", "--filter", "@seed/worker", "exec", "tsx", "src/index.ts"]
