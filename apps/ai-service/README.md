# ai-service

Python / FastAPI. Hosts the five AI engines (voice agent, writing evaluation,
exam simulation, adaptive learning, readiness prediction) plus the calibration
pipeline (Phase 0, already built — see `app/calibration/`).

## DB access pattern — read this before adding a query

- `app/db/models/` — SQLAlchemy ORM models. These exist ONLY as the source
  Alembic reads to autogenerate migrations. Do not query through them at runtime.
- `app/db/repositories/` — asyncpg raw queries. This is the actual runtime
  data-access path. All scores are stored as NUMERIC(4,2); match that in
  every query that touches a score column.

## Providers

`app/providers/` wraps every external LLM/STT/TTS vendor behind a common
interface (`base.py` in each subfolder) so a provider swap (e.g. Groq → another
LLM vendor, gTTS → ElevenLabs in Phase 2) never touches engine code.

## Logs and error reports

Log lines are JSON in the gateway's shape (`time`, `level`, `service`, `requestId`, `msg`), uvicorn's included. `app/core/request_id.py` takes the request id from `x-request-id` (a new one when it is missing or invalid), returns it, and logs one `request completed` line per request; Docker's `/health` probes are not logged.

Unhandled errors go to Bugsink when `SENTRY_DSN` is set. Request bodies, local variables, user fields and query strings are never sent, because the bodies and the scoring code's locals hold essays (`app/core/monitoring.py`). A failed scoring keeps the model's output out of its error message for the same reason.

`python -m app.core.monitoring` sends one test error with the container's settings.
