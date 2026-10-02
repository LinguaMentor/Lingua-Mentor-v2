# LinguaMentor

AI language and exam preparation platform for English, French and German exams (TCF, IELTS, Goethe and more): lessons from A1, calibrated writing scoring and adaptive learning, for learners across Africa, Asia and Latin America.

## Repo layout

This is a polyglot monorepo: the frontend and API gateway are TypeScript/Node,
managed as a pnpm workspace; the AI service and background worker are Python,
managed independently.

    apps/
      frontend/       Next.js 14 PWA
      api-gateway/     Node.js / Fastify: REST, SSE, voice WebSocket
      ai-service/      Python / FastAPI: scoring, chat and content engines
      worker/          Python / BullMQ consumer: background jobs on Redis
    packages/
      shared-types/    TS types shared between frontend and api-gateway
      shared-schemas/  zod schemas shared between frontend and api-gateway
    infra/             docker-compose, Coolify config
    docs/              pointer to the product documents (kept private)
    scripts/           one-off operational scripts

## Getting started

1. Copy every `.env.example` in `apps/*` to `.env` and fill in real values.
2. `pnpm install` at the repo root (installs frontend + api-gateway + packages).
3. For ai-service and worker: `cd apps/ai-service && poetry install` (repeat for `worker/`).
4. `docker compose -f infra/docker-compose.yml up -d redis` to start Redis.

## Running locally

Anything that goes through the queue (writing evaluation, appeals, daily sessions) needs all four processes:

```bash
pnpm dev:frontend      # :3001
pnpm dev:api-gateway   # :3000
pnpm dev:ai-service    # :8000
pnpm dev:worker        # no port; easy to forget, and queued jobs stall without it
```

## Working on the project

- How we work, and what is being worked on: [LinguaMentor Delivery](https://github.com/orgs/LinguaMentor/projects/2)
- Product documents: [`docs/prd/`](docs/prd/README.md)
