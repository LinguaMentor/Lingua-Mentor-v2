FROM python:3.12-slim AS builder
WORKDIR /app

# Poetry is only needed at build time.
RUN pip install --no-cache-dir poetry==2.4.1

# Keep the venv inside the project so the runtime image can copy it as-is.
ENV POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1 \
    PIP_NO_CACHE_DIR=1

# Copy dependency files first to keep rebuilds fast.
COPY pyproject.toml poetry.lock ./
# Install app deps without installing the project package itself.
RUN poetry install --only main --no-root

COPY app ./app
COPY alembic.ini ./alembic.ini
COPY alembic ./alembic

FROM python:3.12-slim AS runtime
WORKDIR /app

# Run the app as a dedicated non-root user.
RUN groupadd --system app && \
    useradd --system --gid app --home-dir /app --no-create-home app

COPY --from=builder /app/.venv ./.venv
COPY --from=builder /app/app ./app
COPY --from=builder /app/alembic.ini ./alembic.ini
COPY --from=builder /app/alembic ./alembic

# Put the venv binaries first so the runtime can call Python and uvicorn directly.
ENV PATH="/app/.venv/bin:${PATH}"

# The runtime key directory is mounted from Docker and should stay readable by the app user.
RUN mkdir -p /app/keys && chown -R app:app /app

USER app
EXPOSE 8000

# Healthcheck against the app's own HTTP endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=3)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
