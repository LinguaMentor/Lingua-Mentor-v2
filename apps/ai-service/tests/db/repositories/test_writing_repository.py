"""Integration tests for the writing_sessions repository lifecycle:
create → mark_processing (with double-delivery guard) → save_score → read back.
"""

from decimal import Decimal

import pytest

from app.db.repositories import writing_repository
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

CATEGORIES = [
    {
        "name": "Task Response",
        "score": Decimal("6.5"),
        "weight": Decimal("0.250"),
        "feedback": "Addresses the task.",
    },
    {
        "name": "Coherence & Cohesion",
        "score": Decimal("6.0"),
        "weight": Decimal("0.250"),
        "feedback": "Mostly logical.",
    },
    {
        "name": "Lexical Resource",
        "score": Decimal("7.0"),
        "weight": Decimal("0.250"),
        "feedback": "Good range.",
    },
    {
        "name": "Grammatical Range & Accuracy",
        "score": Decimal("6.0"),
        "weight": Decimal("0.250"),
        "feedback": "Some errors.",
    },
]


async def _create(db_conn, learner_profile_id):
    return await writing_repository.create_session(
        db_conn,
        learner_profile_id=learner_profile_id,
        exam_type="ielts_academic",
        prompt_text="Some people think...",
        essay_text="In my opinion..." * 50,
        word_count=250,
    )


async def test_full_scoring_lifecycle(db_conn, learner_profile_id):
    session_id = await _create(db_conn, learner_profile_id)

    assert await writing_repository.mark_processing(db_conn, session_id) is True
    # Double delivery must be rejected once no longer pending.
    assert await writing_repository.mark_processing(db_conn, session_id) is False

    await writing_repository.save_score(
        db_conn,
        session_id=session_id,
        overall_band_score=Decimal("6.50"),
        cefr_level="B2",
        calibration_version="v1.0-launch",
        categories=CATEGORIES,
        grammar_corrections=[{"error": "a", "fix": "b"}],
        vocabulary_suggestions=None,
    )

    row = await writing_repository.get_session_with_breakdown(db_conn, session_id)
    assert row["status"] == "scored"
    assert row["overall_band_score"] == Decimal("6.50")
    assert row["cefr_level"] == "B2"
    assert row["calibration_version"] == "v1.0-launch"
    assert row["category_1_name"] == "Task Response"
    assert row["category_3_score"] == Decimal("7.00")
    assert row["scored_at"] is not None


async def test_three_category_rubric_leaves_slot_4_null(db_conn, learner_profile_id):
    """TOEFL's official rubric has 3 categories — slot 4 stays NULL."""
    session_id = await _create(db_conn, learner_profile_id)
    await writing_repository.save_score(
        db_conn,
        session_id=session_id,
        overall_band_score=Decimal("6.00"),
        cefr_level="B2",
        calibration_version=None,
        categories=CATEGORIES[:3],
        grammar_corrections=None,
        vocabulary_suggestions=None,
    )
    row = await writing_repository.get_session_with_breakdown(db_conn, session_id)
    assert row["category_3_name"] == "Lexical Resource"
    assert row["category_4_name"] is None
    assert row["category_4_score"] is None


async def test_save_score_rejects_wrong_category_count(db_conn, learner_profile_id):
    session_id = await _create(db_conn, learner_profile_id)
    with pytest.raises(ValueError, match="3 or 4"):
        await writing_repository.save_score(
            db_conn,
            session_id=session_id,
            overall_band_score=Decimal("6.00"),
            cefr_level="B2",
            calibration_version=None,
            categories=CATEGORIES[:2],
            grammar_corrections=None,
            vocabulary_suggestions=None,
        )


async def test_mark_failed(db_conn, learner_profile_id):
    session_id = await _create(db_conn, learner_profile_id)
    await writing_repository.mark_failed(db_conn, session_id)
    row = await writing_repository.get_session_with_breakdown(db_conn, session_id)
    assert row["status"] == "failed"
    assert row["category_1_name"] is None  # no breakdown row
