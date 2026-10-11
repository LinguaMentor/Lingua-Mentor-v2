"""Typed settings from environment variables — fail fast, list what's missing."""

import os
from dataclasses import dataclass
from pathlib import Path

_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


@dataclass(frozen=True)
class Settings:
    redis_url: str
    database_url: str
    ai_service_url: str
    concurrency: int = 2
    # ADR 0009 §2.2 — pre-generate only for learners who actually open the app.
    pregeneration_active_window_days: int = 14
    # Error reports go to Bugsink when a DSN is set; the release is the image's commit.
    sentry_dsn: str = ""
    sentry_environment: str = "development"
    sentry_release: str = ""


def _load_dotenv() -> None:
    """Populate env from apps/worker/.env for local dev, matching how ai-service
    reads its own (pydantic-settings). A no-op in containers, where the file is
    absent and the runtime supplies env; setdefault lets real env always win."""
    if not _ENV_FILE.is_file():
        return
    for line in _ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def load_settings() -> Settings:
    _load_dotenv()
    required = {
        name: os.environ.get(name) for name in ("REDIS_URL", "DATABASE_URL", "AI_SERVICE_URL")
    }
    missing = sorted(name for name, value in required.items() if not value)
    if missing:
        raise RuntimeError(f"missing required environment variables: {', '.join(missing)}")
    return Settings(
        redis_url=required["REDIS_URL"],  # type: ignore[arg-type]
        database_url=required["DATABASE_URL"],  # type: ignore[arg-type]
        ai_service_url=required["AI_SERVICE_URL"],  # type: ignore[arg-type]
        concurrency=int(os.environ.get("WORKER_CONCURRENCY", "2")),
        pregeneration_active_window_days=int(
            os.environ.get("PREGENERATION_ACTIVE_WINDOW_DAYS", "14")
        ),
        sentry_dsn=os.environ.get("SENTRY_DSN", ""),
        sentry_environment=os.environ.get("SENTRY_ENVIRONMENT", "development"),
        sentry_release=os.environ.get("SENTRY_RELEASE", ""),
    )
