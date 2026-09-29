"""Appeal task logic against a real (rolled-back) Postgres with a faked
ai-service — same harness pattern as test_writing_eval_task.py."""

import json
from decimal import Decimal

import httpx
import pytest
import pytest_asyncio

from app.clients.ai_service import RetryableEvalError
from app.tasks.appeal_eval_task import run_appeal_eval
from tests.conftest import mock_http, requires_db

pytestmark = [requires_db]


@pytest_asyncio.fixture
async def scored_session_id(db_conn, learner_profile_id):
    """A scored session — the only state an appeal can exist against."""
    return await db_conn.fetchval(
        """
        INSERT INTO writing_sessions
            (learner_profile_id, exam_type, prompt_text, essay_text, word_count,
             status, overall_band_score, cefr_level, calibration_version)
        VALUES ($1, 'ielts_academic', 'Discuss both views.', 'Essay text here.', 3,
                'scored', 6.50, 'B2', 'v1.0-launch')
        RETURNING id
        """,
        learner_profile_id,
    )


@pytest_asyncio.fixture
async def appeal_id(db_conn, learner_profile_id, scored_session_id):
    """A pending appeal, as the gateway's appeal endpoint creates it."""
    return await db_conn.fetchval(
        """
        INSERT INTO score_appeals
            (writing_session_id, learner_profile_id, appeal_reason, original_score)
        VALUES ($1, $2, 'feels low', 6.50)
        RETURNING id
        """,
        scored_session_id,
        learner_profile_id,
    )


def appeal_payload(secondary: str = "7.50") -> dict:
    """A realistic 200 response from /api/v1/writing-eval/appeal."""
    return {
        "exam_type": "ielts_academic",
        "overall_band_score": secondary,
        "cefr_level": "C1",
        "categories": [
            {
                "key": "task_response",
                "name": "Task Response",
                "score": secondary,
                "weight": "0.250",
                "feedback": "ok",
            },
            {
                "key": "coherence_cohesion",
                "name": "Coherence & Cohesion",
                "score": secondary,
                "weight": "0.250",
                "feedback": "ok",
            },
            {
                "key": "lexical_resource",
                "name": "Lexical Resource",
                "score": secondary,
                "weight": "0.250",
                "feedback": "ok",
            },
            {
                "key": "grammatical_range",
                "name": "Grammatical Range & Accuracy",
                "score": secondary,
                "weight": "0.250",
                "feedback": "ok",
            },
        ],
        "grammar_corrections": [],
        "vocabulary_suggestions": [],
        "calibration_version": "v1.0-launch",
        "provider": "groq",
        "model_name": "llama-3.3-70b-versatile",
        "model_version": "llama-3.3-70b-versatile",
        "prompt_hash": "x",
        "response_hash": "y",
        "input_token_count": 1000,
        "output_token_count": 400,
        "latency_ms": 900,
        "was_fallback": False,
        "ai_model_run_id": "0a1b2c3d-aaaa-4bbb-8ccc-ddddeeeeffff",
        "secondary_model_config": {
            "prompt_variant": "appeal",
            "temperature": 0.3,
            "provider": "groq",
            "model_name": "llama-3.3-70b-versatile",
            "model_version": "llama-3.3-70b-versatile",
        },
    }


async def test_large_delta_resolves_and_flags_human_review(db_conn, fake_pool, appeal_id):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json=appeal_payload("7.50"))

    async with mock_http(handler) as http:
        outcome = await run_appeal_eval(
            appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "resolved"
    # The worker hit the appeal endpoint with the session row's essay — not
    # anything from the queue payload.
    path, body = calls[0]
    assert path == "/api/v1/writing-eval/appeal"
    assert body["essay_text"] == "Essay text here."
    assert body["appeal_id"] == str(appeal_id)
    assert "original_score" not in body  # the re-mark must never see it

    row = await db_conn.fetchrow("SELECT * FROM score_appeals WHERE id = $1", appeal_id)
    assert row["status"] == "resolved"
    assert row["secondary_score"] == Decimal("7.50")
    assert row["discrepancy_delta"] == Decimal("1.00")
    assert row["requires_human_review"] is True  # 1.00 > 0.5 (PRD §21.4)
    assert json.loads(row["secondary_model_config"])["prompt_variant"] == "appeal"
    assert row["resolved_at"] is not None


async def test_half_band_delta_does_not_flag_human_review(db_conn, fake_pool, appeal_id):
    # Exactly 0.5 is the boundary: the flag is for deltas *greater than* half
    # a band, so 6.50 -> 6.00 resolves quietly.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=appeal_payload("6.00"))

    async with mock_http(handler) as http:
        outcome = await run_appeal_eval(
            appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "resolved"
    row = await db_conn.fetchrow(
        "SELECT discrepancy_delta, requires_human_review FROM score_appeals WHERE id = $1",
        appeal_id,
    )
    assert row["discrepancy_delta"] == Decimal("0.50")
    assert row["requires_human_review"] is False


async def test_terminal_400_marks_failed_without_raising(db_conn, fake_pool, appeal_id):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"error": {"code": "UNKNOWN_EXAM", "message": "nope", "field": "exam_type"}}
        )

    async with mock_http(handler) as http:
        outcome = await run_appeal_eval(
            appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "failed"
    status = await db_conn.fetchval("SELECT status FROM score_appeals WHERE id = $1", appeal_id)
    assert status == "failed"


async def test_retryable_502_resets_to_pending_and_raises(db_conn, fake_pool, appeal_id):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"error": {"code": "EVALUATION_FAILED", "message": "burp"}})

    async with mock_http(handler) as http:
        with pytest.raises(RetryableEvalError):
            await run_appeal_eval(
                appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=False
            )

    status = await db_conn.fetchval("SELECT status FROM score_appeals WHERE id = $1", appeal_id)
    assert status == "pending"  # visible state while the job sits in backoff


async def test_retryable_502_on_final_attempt_marks_failed_and_raises(
    db_conn, fake_pool, appeal_id
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"error": {"code": "EVALUATION_FAILED", "message": "burp"}})

    async with mock_http(handler) as http:
        with pytest.raises(RetryableEvalError):
            await run_appeal_eval(
                appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=True
            )

    status = await db_conn.fetchval("SELECT status FROM score_appeals WHERE id = $1", appeal_id)
    assert status == "failed"


async def test_double_delivery_of_resolved_appeal_skips_without_calling_ai_service(
    db_conn, fake_pool, appeal_id
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=appeal_payload())

    async with mock_http(handler) as http:
        await run_appeal_eval(
            appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    def must_not_be_called(request: httpx.Request) -> httpx.Response:
        raise AssertionError("ai-service must not be called for a resolved appeal")

    async with mock_http(must_not_be_called) as http:
        outcome = await run_appeal_eval(
            appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "skipped"


async def test_redelivery_of_processing_appeal_claims_and_resolves(db_conn, fake_pool, appeal_id):
    # Simulate a stalled first delivery that died mid-processing.
    await db_conn.execute("UPDATE score_appeals SET status = 'processing' WHERE id = $1", appeal_id)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=appeal_payload())

    async with mock_http(handler) as http:
        outcome = await run_appeal_eval(
            appeal_id=appeal_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "resolved"
