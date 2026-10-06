RUN_THIS_IS_NOT_A_DOCKER_INSTRUCTION
# Multi-stage — see apps/ai-service/Dockerfile for the full rationale
# (same pattern, mirrored here).

FROM python:3.12-slim AS builder
WORKDIR /app

RUN pip install --no-cache-dir poetry==2.4.1

ENV POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1 \
    PIP_NO_CACHE_DIR=1

COPY pyproject.toml poetry.lock ./
RUN poetry install --only main --no-root

COPY app ./app

FROM python:3.12-slim AS runtime
WORKDIR /app

RUN groupadd --system app && \
    useradd --system --gid app --home-dir /app --no-create-home app

COPY --from=builder /app/.venv ./.venv
COPY --from=builder /app/app ./app

ENV PATH="/app/.venv/bin:${PATH}"

RUN chown -R app:app /app
USER app

# worker/ is a pure BullMQ consumer (app/main.py) with no HTTP surface to
# probe — there's no /health route to hit. Instead, check that the
# top-level process (PID 1 under Docker, since there's no shell/entrypoint
# wrapping it) is still the worker process and hasn't crashed out from
# under its supervisor. grep is present in python:3.12-slim's Debian base
# without adding any extra package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD grep -q "app.main" /proc/1/cmdline || exit 1

CMD ["python", "-m", "app.main"]
