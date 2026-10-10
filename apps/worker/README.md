# worker

Python BullMQ background job consumer, backed by Redis. Uses the official
`bullmq` Python client so it consumes the exact queue format the Node
producer in `api-gateway/src/queue/` writes (per ADR 0001 §5 — this service
is a BullMQ consumer). Handles long-running
work that shouldn't block a request/response cycle or a voice turn: essay
scoring pipeline, appeal re-evaluation, nightly SRS batch generation,
calibration recompute.

Queue names should match what api-gateway and ai-service enqueue against —
keep `app/tasks/` filenames aligned 1:1 with queue names for easy tracing.

## Running the tests

```bash
poetry install
DATABASE_URL=postgresql://postgres:dev@localhost:5432/linguamentor poetry run pytest
```

DB-backed tests are skipped (not failed) when `DATABASE_URL` is unset. They
run against a real Postgres with the `ai-service` migrations applied — the
worker has no migrations of its own, since it reads/writes the same schema
ai-service owns.

## Manual end-to-end smoke test

This drives a real essay through the whole pipeline — gateway → Redis →
worker → ai-service — without any of the individual test suites' fakes, to
confirm the pieces actually talk to each other correctly.

1. **Throwaway Postgres, with migrations applied:**

   ```bash
   docker run -d --rm --name lm-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=linguamentor -p 5432:5432 postgres:16-alpine
   cd apps/ai-service
   DATABASE_URL=postgresql://postgres:dev@localhost:5432/linguamentor poetry run alembic upgrade head
   ```

2. **Seed one learner** (`writing_sessions` needs a `learner_profile_id` to hang off):

   ```bash
   docker exec lm-pg psql -U postgres -d linguamentor -tAc "
     WITH u AS (INSERT INTO users (email, password_hash, display_name) VALUES ('e2e@test.dev','x','E2E Learner') RETURNING id)
     INSERT INTO learner_profiles (user_id, target_language, target_exam) SELECT id, 'en', 'ielts_academic' FROM u RETURNING id;"
   ```

   Note the returned UUID — that's the `learner_profile_id` for the requests below.

3. **Start Redis, ai-service, the worker, and the gateway.** Without a real
   `GROQ_API_KEY`, run ai-service with its LLM provider faked via the same
   `app.dependency_overrides[get_llm_provider]` mechanism its own API tests
   use (see `apps/ai-service/tests/api/v1/routers/test_writing_eval.py` for
   the pattern) — everything else (the engine, schema validation,
   `AIModelRun` logging, the error envelope) runs for real; only the vendor
   HTTP call is stubbed.

   Point each service's `.env` at the throwaway Postgres and a shared Redis,
   then bring them up (either individually with `pnpm dev` / `poetry run
   python -m app.main` / `uvicorn`, or via `docker compose -f
   infra/docker-compose.yml up --build`).

4. **Register a test user** (see `apps/api-gateway/README.md` § Auth) to
   get a real access token and `learner_profile_id`, then submit an essay
   and poll for the result:

   ```bash
   curl -s -X POST http://localhost:3000/api/v1/writing/submit \
     -H "content-type: application/json" -H "authorization: Bearer <access token>" \
     -d '{"exam_type":"ielts_academic","prompt_text":"Some people believe technology has improved education. Discuss.","essay_text":"In recent decades, technology has transformed the classroom..."}'
   # → {"session_id": "...", "status": "pending"}

   curl -s http://localhost:3000/api/v1/writing/result/<session_id> -H "authorization: Bearer <access token>"
   # poll until "status": "scored" — should take well under a second with
   # the faked provider, and land inside the <6s P95 target (PRD §9.1)
   # against a real one.
   ```

5. **Verify the negative path**: submit with `"exam_type": "bogus_exam"`.
   It should reach `"status": "failed"` after **exactly one** worker
   attempt — check the worker's log for a single `terminal failure` line
   with no retries, since a 400 from ai-service (unknown exam) is a
   permanent failure, not a transient one worth retrying.

6. **Check the audit trail**: `SELECT session_type, task_type, provider,
   model_name, latency_ms FROM ai_model_runs;` should show one row per
   evaluation attempt, tying every score back to a specific model version
   (PRD §11.5).

Tear down: stop the services, then `docker stop lm-pg`.

## Logs and error reports

Log lines are JSON in the gateway's shape. Each job runs under the `request_id` in its payload, the id of the request that queued it, or a new one for scheduled jobs; the nightly batch passes its own to every job it fans out. Calls to ai-service carry it as `x-request-id`.

When `SENTRY_DSN` is set, anything logged at error level goes to Bugsink, including the last failed attempt of a scoring job. So does an unexpected exception in a job, which bullmq would otherwise record silently. Local variables are never sent: a task's frames hold the essay it is scoring (`app/monitoring.py`).

`python -m app.monitoring` sends one test error with the container's settings.
