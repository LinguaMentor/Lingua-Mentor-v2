"""claim/reset/fail/save lifecycle against a real Postgres (rolled back)."""

from decimal import Decimal

import pytest

from app.db.writing_queries import claim_session, mark_failed, reset_to_pending, save_score
from tests.conftest import requires_db

pytestmark = [requires_db]


def _categories(n: int) -> list[dict]:
    return [
        {
            "name": f"Category {i}",
            "score": Decimal("6.50"),
            "weight": Decimal("0.250") if n == 4 else Decimal("0.333"),
            "feedback": f"feedback {i}",
        }
        for i in range(1, n + 1)
    ]


async def test_claim_pending_session_returns_row_and_sets_processing(db_conn, writing_session_id):
    row = await claim_session(db_conn, writing_session_id)

    assert row is not None
    assert row["exam_type"] == "ielts_academic"
    assert row["essay_text"] == "Essay text here."
    status = await db_conn.fetchval(
        "SELECT status FROM writing_sessions WHERE id = $1", writing_session_id
    )
    assert status == "processing"


async def test_claim_accepts_processing_status_for_retry_redelivery(db_conn, writing_session_id):
    # First delivery claims pending → processing; a retry (or stalled-job
    # redelivery) must be able to claim again.
    assert await claim_session(db_conn, writing_session_id) is not None
    assert await claim_session(db_conn, writing_session_id) is not None


async def test_claim_skips_scored_session(db_conn, writing_session_id):
    await claim_session(db_conn, writing_session_id)
    await save_score(
        db_conn,
        session_id=writing_session_id,
        overall_band_score=Decimal("6.50"),
        cefr_level="B2",
        calibration_version=None,
        categories=_categories(4),
        grammar_corrections=None,
        vocabulary_suggestions=None,
    )

    assert await claim_session(db_conn, writing_session_id) is None


async def test_claim_skips_failed_session(db_conn, writing_session_id):
    await mark_failed(db_conn, writing_session_id)

    assert await claim_session(db_conn, writing_session_id) is None


async def test_reset_to_pending_round_trips(db_conn, writing_session_id):
    await claim_session(db_conn, writing_session_id)
    await reset_to_pending(db_conn, writing_session_id)

    status = await db_conn.fetchval(
        "SELECT status FROM writing_sessions WHERE id = $1", writing_session_id
    )
    assert status == "pending"


async def test_save_score_pads_three_category_rubric_with_null_fourth_slot(
    db_conn, writing_session_id
):
    await claim_session(db_conn, writing_session_id)
    await save_score(
        db_conn,
        session_id=writing_session_id,
        overall_band_score=Decimal("7.00"),
        cefr_level="C1",
        calibration_version="v1.0-launch",
        categories=_categories(3),
        grammar_corrections=[{"original": "a", "correction": "b"}],
        vocabulary_suggestions=[],
    )

    row = await db_conn.fetchrow(
        """
        SELECT ws.status, ws.overall_band_score, ws.scored_at,
               b.category_3_name, b.category_4_name, b.category_4_score
        FROM writing_sessions ws
        JOIN writing_score_breakdowns b ON b.writing_session_id = ws.id
        WHERE ws.id = $1
        """,
        writing_session_id,
    )
    assert row["status"] == "scored"
    assert row["overall_band_score"] == Decimal("7.00")
    assert row["scored_at"] is not None
    assert row["category_3_name"] == "Category 3"
    assert row["category_4_name"] is None
    assert row["category_4_score"] is None


async def test_save_score_rejects_wrong_category_count(db_conn, writing_session_id):
    with pytest.raises(ValueError, match="expected 3 or 4"):
        await save_score(
            db_conn,
            session_id=writing_session_id,
            overall_band_score=Decimal("6.00"),
            cefr_level="B2",
            calibration_version=None,
            categories=_categories(2),
            grammar_corrections=None,
            vocabulary_suggestions=None,
        )
