"""End-to-end task logic against a real (rolled-back) Postgres with a faked
ai-service, mirroring how FakeProvider stands in for the LLM in ai-service."""

import json
from decimal import Decimal

import httpx
import pytest

from app.clients.ai_service import RetryableEvalError
from app.tasks.writing_eval_task import run_writing_eval
from tests.conftest import mock_http, requires_db

pytestmark = [requires_db]


def evaluate_payload() -> dict:
    """A realistic 200 response from /api/v1/writing-eval/evaluate."""
    return {
        "exam_type": "ielts_academic",
        "overall_band_score": "6.50",
        "cefr_level": "B2",
        "categories": [
            {
                "key": "task_response",
                "name": "Task Response",
                "score": "6.50",
                "weight": "0.250",
                "feedback": "ok",
            },
            {
                "key": "coherence_cohesion",
                "name": "Coherence & Cohesion",
                "score": "6.00",
                "weight": "0.250",
                "feedback": "ok",
            },
            {
                "key": "lexical_resource",
                "name": "Lexical Resource",
                "score": "7.00",
                "weight": "0.250",
                "feedback": "ok",
            },
            {
                "key": "grammatical_range",
                "name": "Grammatical Range & Accuracy",
                "score": "6.50",
                "weight": "0.250",
                "feedback": "ok",
            },
        ],
        "grammar_corrections": [{"original": "a", "correction": "b", "explanation": "c"}],
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
    }


async def test_happy_path_scores_session_with_decimal_round_trip(
    db_conn, fake_pool, writing_session_id
):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=evaluate_payload())

    async with mock_http(handler) as http:
        outcome = await run_writing_eval(
            session_id=writing_session_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "scored"
    # The worker sent the DB row's content, not queue-payload data.
    assert calls[0]["essay_text"] == "Essay text here."
    assert calls[0]["session_type"] == "submission"

    row = await db_conn.fetchrow(
        """
        SELECT ws.status, ws.overall_band_score, ws.cefr_level, ws.calibration_version,
               b.category_1_score, b.grammar_corrections
        FROM writing_sessions ws
        JOIN writing_score_breakdowns b ON b.writing_session_id = ws.id
        WHERE ws.id = $1
        """,
        writing_session_id,
    )
    assert row["status"] == "scored"
    assert row["overall_band_score"] == Decimal("6.50")
    assert row["cefr_level"] == "B2"
    assert row["calibration_version"] == "v1.0-launch"
    assert row["category_1_score"] == Decimal("6.50")
    assert json.loads(row["grammar_corrections"])[0]["correction"] == "b"


async def test_terminal_400_marks_failed_without_raising(db_conn, fake_pool, writing_session_id):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"error": {"code": "UNKNOWN_EXAM", "message": "nope", "field": "exam_type"}}
        )

    async with mock_http(handler) as http:
        outcome = await run_writing_eval(
            session_id=writing_session_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "failed"
    status = await db_conn.fetchval(
        "SELECT status FROM writing_sessions WHERE id = $1", writing_session_id
    )
    assert status == "failed"


async def test_retryable_502_resets_to_pending_and_raises(db_conn, fake_pool, writing_session_id):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"error": {"code": "EVALUATION_FAILED", "message": "burp"}})

    async with mock_http(handler) as http:
        with pytest.raises(RetryableEvalError):
            await run_writing_eval(
                session_id=writing_session_id, pool=fake_pool, http=http, is_final_attempt=False
            )

    status = await db_conn.fetchval(
        "SELECT status FROM writing_sessions WHERE id = $1", writing_session_id
    )
    assert status == "pending"  # visible state while the job sits in backoff


async def test_retryable_502_on_final_attempt_marks_failed_and_raises(
    db_conn, fake_pool, writing_session_id
):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"error": {"code": "EVALUATION_FAILED", "message": "burp"}})

    async with mock_http(handler) as http:
        with pytest.raises(RetryableEvalError):
            await run_writing_eval(
                session_id=writing_session_id, pool=fake_pool, http=http, is_final_attempt=True
            )

    status = await db_conn.fetchval(
        "SELECT status FROM writing_sessions WHERE id = $1", writing_session_id
    )
    assert status == "failed"


async def test_double_delivery_of_completed_session_skips_without_calling_ai_service(
    db_conn, fake_pool, writing_session_id
):
    def scoring_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=evaluate_payload())

    async with mock_http(scoring_handler) as http:
        await run_writing_eval(
            session_id=writing_session_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    def must_not_be_called(request: httpx.Request) -> httpx.Response:
        raise AssertionError("ai-service must not be called for a completed session")

    async with mock_http(must_not_be_called) as http:
        outcome = await run_writing_eval(
            session_id=writing_session_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "skipped"


async def test_redelivery_of_processing_session_claims_and_scores(
    db_conn, fake_pool, writing_session_id
):
    # Simulate a stalled first delivery that died mid-processing.
    await db_conn.execute(
        "UPDATE writing_sessions SET status = 'processing' WHERE id = $1", writing_session_id
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=evaluate_payload())

    async with mock_http(handler) as http:
        outcome = await run_writing_eval(
            session_id=writing_session_id, pool=fake_pool, http=http, is_final_attempt=False
        )

    assert outcome == "scored"
