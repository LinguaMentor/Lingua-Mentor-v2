"""Settings validated at boot: production never runs on the fake LLM."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings

SERVICE_ROOT = Path(__file__).resolve().parents[2]
REFUSAL = "LLM_PROVIDER=fake is not allowed when APP_ENV=production"


def test_production_refuses_the_fake_provider_without_printing_settings():
    with pytest.raises(ValidationError, match=REFUSAL) as refused:
        Settings(_env_file=None, app_env="production", llm_provider="fake", groq_api_key="gsk_x")
    assert "gsk_x" not in str(refused.value)


@pytest.mark.parametrize("app_env", ["development", "test", "staging"])
def test_other_environments_accept_the_fake_provider(app_env):
    assert Settings(_env_file=None, app_env=app_env, llm_provider="fake").llm_provider == "fake"


def test_production_accepts_a_real_provider():
    assert (
        Settings(_env_file=None, app_env="production", llm_provider="groq").app_env == "production"
    )


def test_an_unknown_provider_or_environment_is_refused():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, llm_provider="openai-but-misspelt")
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env="prod")


def test_the_service_will_not_start_with_the_fake_provider_in_production():
    env = {**os.environ, "APP_ENV": "production", "LLM_PROVIDER": "fake", "SENTRY_DSN": ""}
    started = subprocess.run(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "0"],
        cwd=SERVICE_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert started.returncode != 0
    assert REFUSAL in started.stderr
