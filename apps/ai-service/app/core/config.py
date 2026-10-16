"""Typed settings loaded from env — pydantic BaseSettings.

One flat settings object; env var names match .env.example exactly.
"""

from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Hidden input: a validation error would otherwise print every setting, keys and DSNs included.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    # Production refuses development-only settings at boot.
    app_env: Literal["development", "test", "staging", "production"] = "development"

    database_url: str = "postgresql://user:pass@localhost/linguamentor"
    redis_url: str = "redis://localhost:6379"
    jwt_public_key_path: str = "./keys/jwt_public.pem"

    # "fake": fixed, valid replies to every AI task with no network, for local, CI and e2e runs.
    llm_provider: Literal["groq", "fake"] = "groq"
    groq_api_key: str = ""
    # Model tiers (PRD §19.3): high for rubric/CEFR, mid for grammar/Socratic.
    # In config so a provider/model change is an env edit.
    llm_model_high_tier: str = "llama-3.3-70b-versatile"
    llm_model_mid_tier: str = "llama-3.1-8b-instant"

    elevenlabs_api_key: str = ""  # Phase 2, unused until then

    # Modest pool: Neon's pooler absorbs connection scale (ADR 0001 §3.1), so
    # this only needs the app's own concurrency.
    db_pool_min_size: int = 1
    db_pool_max_size: int = 10

    # Error reports go to Bugsink when a DSN is set; the release is the image's commit.
    sentry_dsn: str = ""
    sentry_environment: str = "development"
    sentry_release: str = ""

    @model_validator(mode="after")
    def _no_fake_llm_in_production(self) -> "Settings":
        if self.app_env == "production" and self.llm_provider == "fake":
            raise ValueError("LLM_PROVIDER=fake is not allowed when APP_ENV=production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
