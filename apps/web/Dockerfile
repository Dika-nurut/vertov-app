# Seed web (Next.js SSR) — INF-15. Build context = repo root:
#   docker build -f apps/web/Dockerfile -t seed-web .
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# NEXT_PUBLIC_* are inlined into the CLIENT bundle at build time (not read at
# runtime), so the production origin and the cred-gated login flags must be set
# HERE, before `next build`. The registered production providers are enabled by
# default so an on-VM/manual build cannot silently ship an email-only login when
# the runtime credentials are present. API-side credentials still gate every
# provider, and non-production builds may explicitly override these ARGs.
ARG NEXT_PUBLIC_API_URL=https://vertov.space
ARG NEXT_PUBLIC_WEB_URL=https://vertov.space
ARG NEXT_PUBLIC_PHONE_ENABLED=1
ARG NEXT_PUBLIC_VK_ENABLED=1
ARG NEXT_PUBLIC_YANDEX_ENABLED=1
ARG NEXT_PUBLIC_MAILRU_ENABLED=0
ARG NEXT_PUBLIC_OK_ENABLED=0
ARG NEXT_PUBLIC_VK_APP_ID=54654115
ARG NEXT_PUBLIC_YANDEX_CLIENT_ID=06c0d6082e8f4e78aaded99e6574a327
ENV NEXT_PUBLIC_YANDEX_CLIENT_ID=$NEXT_PUBLIC_YANDEX_CLIENT_ID \
    NEXT_PUBLIC_VK_APP_ID=$NEXT_PUBLIC_VK_APP_ID \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL \
    NEXT_PUBLIC_PHONE_ENABLED=$NEXT_PUBLIC_PHONE_ENABLED \
    NEXT_PUBLIC_VK_ENABLED=$NEXT_PUBLIC_VK_ENABLED \
    NEXT_PUBLIC_YANDEX_ENABLED=$NEXT_PUBLIC_YANDEX_ENABLED \
    NEXT_PUBLIC_MAILRU_ENABLED=$NEXT_PUBLIC_MAILRU_ENABLED \
    NEXT_PUBLIC_OK_ENABLED=$NEXT_PUBLIC_OK_ENABLED
# Next compiles + transpiles the @seed/* workspace packages at build time.
RUN pnpm --filter @seed/web build

FROM node:22-bookworm-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node --from=build /app /app
# Bake pnpm — `corepack enable` is only a shim that fetches the pinned version
# from npmjs on first use, so container start would depend on npmjs being
# reachable from the production VM. See apps/api/Dockerfile for the incident.
ENV COREPACK_HOME=/opt/corepack
RUN corepack prepare --activate && chmod -R a+rX /opt/corepack
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Audit M5 (DS-0002): drop root to the image's unprivileged `node` user.
USER node
CMD ["pnpm", "--filter", "@seed/web", "exec", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
