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
