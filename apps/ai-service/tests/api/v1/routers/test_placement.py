"""API tests for /api/v1/placement — full ASGI stack, fake LLM, real DB.

Verifies the writing-anchored placement (PRD §22.3): a scored essay initialises
the 4D CEFR profile with writing assessed + reading proxied, speaking/listening
pending, and persists it to learner_profiles.
"""

import json
import uuid

import httpx
import pytest

from app.api.v1.deps import get_db, get_llm_provider
from app.main import app
from tests.conftest import requires_db
from tests.engines.writing_evaluation.test_engine import FakeProvider, _valid_ielts_payload

pytestmark = [pytest.mark.asyncio, requires_db]


@pytest.fixture
def client(db_conn):
    provider = FakeProvider([json.dumps(_valid_ielts_payload())])
    app.dependency_overrides[get_db] = lambda: db_conn
    app.dependency_overrides[get_llm_provider] = lambda: provider
    transport = httpx.ASGITransport(app=app)
    yield httpx.AsyncClient(transport=transport, base_url="http://test")
    app.dependency_overrides.clear()


async def test_placement_initializes_and_persists_4d_profile(client, db_conn, learner_profile_id):
    response = await client.post(
        "/api/v1/placement/evaluate",
        json={
            "learner_profile_id": str(learner_profile_id),
            "exam_type": "ielts_academic",
            "prompt_text": "Discuss whether X.",
            "essay_text": "In my view, X because...",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()

    # Composite 6.375 → band 6.50 → CEFR B2 (ielts_academic cefr_mapping).
    assert body["writing"] == {"level": "B2", "source": "assessed", "note": None}
    assert body["reading"]["level"] == "B2"
    assert body["reading"]["source"] == "proxy"
    assert body["speaking"]["level"] is None
    assert body["speaking"]["source"] == "pending"
    assert body["listening"]["source"] == "pending"
    assert body["placement_completed"] is True

    # Persisted to learner_profiles, onboarding flipped, speaking/listening NULL.
    row = await db_conn.fetchrow("SELECT * FROM learner_profiles WHERE id = $1", learner_profile_id)
    assert row["cefr_writing"] == "B2"
    assert row["cefr_reading"] == "B2"
    assert row["cefr_speaking"] is None
    assert row["placement_completed_at"] is not None
    assert row["onboarding_completed"] is True

    # An AIModelRun row records the placement LLM call (PRD §28.2).
    run = await db_conn.fetchrow(
        "SELECT * FROM ai_model_runs WHERE task_type = 'placement_writing'"
    )
    assert run is not None and run["session_type"] == "placement"


async def test_get_profile_returns_stored_view(client, db_conn, learner_profile_id):
    await client.post(
        "/api/v1/placement/evaluate",
        json={
            "learner_profile_id": str(learner_profile_id),
            "exam_type": "ielts_academic",
            "prompt_text": "p",
            "essay_text": "e",
        },
    )
    response = await client.get(f"/api/v1/placement/profile/{learner_profile_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["writing"]["level"] == "B2"
    assert body["placement_completed"] is True


async def test_get_profile_unknown_id_is_404(client):
    response = await client.get(f"/api/v1/placement/profile/{uuid.uuid4()}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_placement_unknown_profile_is_404(client):
    response = await client.post(
        "/api/v1/placement/evaluate",
        json={
            "learner_profile_id": str(uuid.uuid4()),
            "exam_type": "ielts_academic",
            "prompt_text": "p",
            "essay_text": "e",
        },
    )
    assert response.status_code == 404
