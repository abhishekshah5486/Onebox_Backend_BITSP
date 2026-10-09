# OneBox Backend

AI-powered email intelligence and automation platform — backend microservices.

## Branching

- `main` — stable, released milestones
- `feature/dev` — integration branch; every change lands here via PR from a branch cut off `feature/dev`

## Getting started

Requires Node 24 (`nvm use`) and Docker.

```bash
npm ci
npm run lint        # eslint
npm run typecheck   # tsc across workspaces
npm test            # unit tests
npm run test:int    # integration tests (needs Docker / .env)
```

## Services

| Service     | Port | Owns                                              |
| ----------- | ---- | ------------------------------------------------- |
| api-gateway | 4000 | Routing, JWT checks, Redis rate limits            |
| auth        | 4001 | Users, sessions, signing keys (`identity` schema) |
| accounts    | 4002 | Connected mailboxes (`accounts` schema)           |
| mail        | 4003 | Ingest worker + conversations API (MongoDB)       |
| settings    | 4004 | Preferences and integrations (`settings` schema)  |
| connector   | 4005 | IMAP IDLE sessions and backfill into `ingest`     |

`npm run dev` starts every service with live reload (needs `.env` and `npm run infra:up`).

## API (via the gateway, `/api/v1`)

All routes except `auth` require `Authorization: Bearer <accessToken>`.

| Method             | Path                                       | Purpose                                                                                 |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| POST               | `/auth/register`, `/auth/login`            | Create account / sign in                                                                |
| POST               | `/auth/refresh`, `/auth/logout`            | Rotate or end the session                                                               |
| GET                | `/auth/me`                                 | Current user                                                                            |
| GET, POST          | `/accounts`                                | List / connect a mailbox (`GMAIL`, `OUTLOOK` or `IMAP`); credentials are verified first |
| GET, PATCH, DELETE | `/accounts/:id`                            | Read, rename, change password, enable/disable, remove                                   |
| POST               | `/accounts/:id/test`                       | Re-check the IMAP connection                                                            |
| GET, PATCH         | `/settings/preferences`                    | Mark-as-seen, autonomy mode, signature, timezone                                        |
| GET, POST          | `/settings/integrations`                   | List / add Slack or signed webhook integrations                                         |
| GET, PATCH, DELETE | `/settings/integrations/:id`               | Manage an integration                                                                   |
| POST               | `/settings/integrations/:id/test`          | Send a test message                                                                     |
| POST               | `/settings/integrations/:id/rotate-secret` | New webhook signing secret (shown once)                                                 |
| GET                | `/mail/threads?filter=&cursor=`            | Unified inbox (`all`, `unread`, `starred`), newest first, cursor-paged                  |
| GET, PATCH         | `/mail/threads/:id`                        | Read a conversation; mark read/unread, star/unstar                                      |
| GET                | `/mail/stats`                              | Unread and starred counts                                                               |

### Ingestion pipeline

connector (IMAP IDLE per mailbox, Redis lease) → BullMQ `ingest` queue (retries, `ingest-dlq`) → mail worker (parse, sanitize, thread) → MongoDB → mail API. Backfill never marks mail as read; new mail is marked read only if the user's preference says so. Every job id is a dedupe key, so replays are harmless.

Errors always look like `{ "error": { "code", "message", "details?" } }`.

## Local infrastructure

```bash
cp .env.example .env                       # then fill in secrets
npm run infra:up                           # redis + elasticsearch
docker compose --profile mail up -d        # greenmail test IMAP/SMTP (3143 / 3025)
docker compose --profile vector up -d      # qdrant
npm run infra:down
```

Postgres runs on Supabase and MongoDB on Atlas; connection strings go in `.env`.

## Kubernetes (local)

```bash
npm run k8s:up      # minikube profile "onebox": builds images, loads secrets from .env, deploys
kubectl --context onebox -n onebox port-forward svc/api-gateway 4000:4000
npm run k8s:down
```

Secrets are created from `.env` at deploy time and never committed; each pod receives only the keys it needs.

Commits follow [Conventional Commits](https://www.conventionalcommits.org), enforced by a commit-msg hook.
