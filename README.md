# Vertov — production application (open build repo)

Public, deployable subset of the Vertov AI video/image SaaS:
`apps/*` (web, api, worker), `packages/*`, DB migrations + seeds, fixtures,
compute compose files, test pyramid, and the CI/deploy workflows.
No internal docs, no credentials, no history from the private repo.

## Deploy

Manual button only: GitHub Actions → `deploy` → Run workflow (optional SHA,
default `main` HEAD). It builds 3 images in parallel, pushes to Yandex
Container Registry, then SSH-deploys with migration + health gates (rollback:
re-run with an older SHA).

## Required repo secrets (Settings → Secrets → Actions)

| Secret | What |
| --- | --- |
| `YC_SA_KEY_JSON` | Service-account authorized key (registry pusher/puller) |
| `YC_REGISTRY_ID` | Container Registry id (`cr.yandex/<id>/seed-*`) |
| `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` | App VM SSH (key never leaves secrets) |
| `DEPLOY_PATH` | Checkout path on the VM (`/opt/seed`) |
| `SEED_SITE_ADDRESS` | Public hostname (`vertov.space`) |
| `WORKER_DEPLOY_HOST` | Worker VM SSH host (same user/key) |

App secrets live ONLY on the VMs (`/run/secrets/seed.env`) — never in git.

## Sync from private

Re-exported from the private repo on release cuts (whitelist + secret scan).
Single source of truth for production code is `main` here once cut.
