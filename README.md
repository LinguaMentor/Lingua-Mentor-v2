# LinguaMentor

AI language and exam preparation platform for English, French and German exams (TCF, IELTS, Goethe and more): lessons from A1, calibrated writing scoring and adaptive learning, for learners across Africa, Asia and Latin America.

## Repo layout

This is a polyglot monorepo: the frontend and API gateway are TypeScript/Node,
managed as a pnpm workspace; the AI service and background worker are Python,
managed independently.

    apps/
      frontend/       Next.js 16 PWA
      api-gateway/     Node.js / Fastify: REST, SSE, voice WebSocket
      ai-service/      Python / FastAPI: scoring, chat and content engines
      worker/          Python / BullMQ consumer: background jobs on Redis
    packages/
      shared-types/    TS types shared between frontend and api-gateway
      shared-schemas/  zod schemas shared between frontend and api-gateway
    e2e/               Playwright journeys against the Compose stack
    infra/             docker-compose, staging host setup, Coolify config
    docs/              pointer to the product documents (kept private)
    scripts/           one-off operational scripts

## Getting started

Docker Engine with Docker Compose v2 is enough to run the full stack locally. Compose supplies its own database, Redis, and service URLs; it does not read the app `.env` files or need Neon credentials.

## Running locally

### Full stack with Compose

From the repository root:

```bash
docker compose -f infra/docker-compose.yml up --build -d
```

Compose starts PostgreSQL 18, Redis, the API gateway, AI service, worker, and the web app. It generates development JWT keys in a named volume and applies Alembic migrations before starting the apps. The first run builds the images; later starts reuse them.

The AI service runs on the fake LLM provider here: every essay is scored 6.0 in each category, with no key and no network. Set `LLM_PROVIDER` and `GROQ_API_KEY` under `ai-service` to try a real model.

Check service status and logs:

```bash
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs -f
```

The web app, gateway, AI service, Postgres, and Redis are available on `127.0.0.1` at ports `3001`, `3000`, `8000`, `5432`, and `6379`. The pages in the browser call the gateway at `http://localhost:3000`, not at the Compose service name. Stop the stack with `docker compose -f infra/docker-compose.yml down`. To remove the database, Redis data, and generated development keys as well, use `docker compose -f infra/docker-compose.yml down -v`.

### Separate processes for hot reload

Install the app dependencies first: `pnpm install`, then `poetry install` in both `apps/ai-service` and `apps/worker`. Start the local database, Redis, and migrations:

```bash
docker compose -f infra/docker-compose.yml up --build -d postgres redis migrate
bash scripts/generate-jwt-keys.sh
```

Set the database and service URLs in each app's `.env` for host-run processes. Use `postgresql://linguamentor:linguamentor@localhost:5432/linguamentor` for `DATABASE_URL`, `redis://localhost:6379` for `REDIS_URL`, and `http://localhost:8000` for `AI_SERVICE_URL`. The gateway and worker need the AI service URL; the other values apply where those variables are used. These host URLs are different from Compose's service-name URLs.

Run these commands in separate terminals:

```bash
pnpm dev:frontend      # :3001
pnpm dev:api-gateway   # :3000
pnpm dev:ai-service    # :8000
pnpm dev:worker
```

Queue-backed features need the gateway, AI service, and worker running together. The Compose web service is a production image; use `pnpm dev:frontend` when you want hot reload.

### End-to-end tests

The Playwright journeys in `e2e/tests/` run in Chromium against the Compose stack above, which must be up:

```bash
pnpm --filter e2e exec playwright install chromium   # once
pnpm --filter e2e test
```

A failure leaves a trace and a screenshot in `e2e/test-results/`; open a trace with `pnpm --filter e2e exec playwright show-trace <path to trace.zip>`. CI runs the same journeys on every pull request that touches an app, the Compose file or `e2e/`, and a failed run uploads them, with the containers' logs, as the `e2e-results` artifact on the run's summary page.

## Working on the project

- How we work, and what is being worked on: [LinguaMentor Delivery](https://github.com/orgs/LinguaMentor/projects/2)
- Product documents: [`docs/prd/`](docs/prd/README.md)
