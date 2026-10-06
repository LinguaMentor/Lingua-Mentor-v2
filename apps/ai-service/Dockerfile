RUN_THIS_IS_NOT_A_DOCKER_INSTRUCTION
# Multi-stage, mirroring apps/api-gateway/Dockerfile's split: a builder
# stage does the (slow, toolchain-heavy) dependency resolution, and the
# runtime stage carries only what's needed to actually run the service.

FROM python:3.12-slim AS builder
WORKDIR /app

# Poetry itself is build-time tooling — it never needs to exist in the
# runtime image, since the venv it produces is self-contained and callable
# directly once copied over.
RUN pip install --no-cache-dir poetry==2.4.1

# In-project venv (.venv/ under /app) so the runtime stage can copy it as
# one self-contained directory instead of poetry having to locate/export it.
ENV POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1 \
    PIP_NO_CACHE_DIR=1

# Lockfile + manifest only, first: this layer is cached until a dependency
# actually changes, so editing app code doesn't force a full reinstall.
COPY pyproject.toml poetry.lock ./
# --only main: production dependencies only — pytest/ruff/mypy (the dev
# group) never enter the image. --no-root: this project has no packages/
# layout for Poetry's package mode (it's run as `uvicorn app.main:app`, not
# imported as an installed distribution), so installing the root project
# itself would fail; this flag skips that and installs only dependencies.
RUN poetry install --only main --no-root

COPY app ./app

FROM python:3.12-slim AS runtime
WORKDIR /app

# Dedicated non-root user — the builder stage above still runs as root
# (needed for system-level pip/poetry installs), but nothing in the
# runtime image has any reason to.
RUN groupadd --system app && \
    useradd --system --gid app --home-dir /app --no-create-home app

COPY --from=builder /app/.venv ./.venv
COPY --from=builder /app/app ./app

# Puts the venv's own binaries (uvicorn, python) first on PATH, so they
# resolve directly — no `poetry run` wrapper needed or available at runtime.
ENV PATH="/app/.venv/bin:${PATH}"

# JWT public key (scripts/generate-jwt-keys.sh) is mounted at runtime, same
# convention api-gateway follows — never baked into the image (see
# .dockerignore). The mount target directory needs to exist and be
# writable by nothing, readable by the app user.
RUN mkdir -p /app/keys && chown -R app:app /app

USER app
EXPOSE 8000

# Liveness probe against the service's own /health route (app/main.py).
# Uses urllib from the stdlib rather than curl/wget — neither is installed
# in the slim base, and pulling one in only for this would add an
# unnecessary package for a single GET request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=3)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
