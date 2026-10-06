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

Commits follow [Conventional Commits](https://www.conventionalcommits.org), enforced by a commit-msg hook.
