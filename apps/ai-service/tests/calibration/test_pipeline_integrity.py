"""Data-pipeline integrity gate (ADR 0006 §2.4).

The score a user sees must be the score the engine produced — no rounding,
ordering, or encoding corruption between engine output, persistence, and the
report read-back. Cambridge/IELTS was fined £875,000 by Ofqual over exactly
this class of mundane pipeline bug (answer-key ordering, diacritic
mishandling), not over AI miscalibration. This exercises the real path —

    evaluate_essay → writing_repository.save_score → get_session_with_breakdown

— and asserts the round-trip introduces zero drift: NUMERIC scores stay Decimal
(never coerced to float), category slots stay in order, and diacritics survive.
Requires a database; skipped (not failed) when DATABASE_URL is unset.
"""

import json
from decimal import Decimal

import pytest

from app.db.repositories import writing_repository
from app.engines.writing_evaluation import evaluate_essay
from tests.conftest import requires_db
from tests.engines.writing_evaluation.test_engine import FakeProvider

pytestmark = [pytest.mark.asyncio, requires_db]


def _payload_with_diacritics() -> dict:
    # Feedback carries accented characters on purpose — the Ofqual failure mode
    # was diacritic mishandling in the pipeline, so we prove they survive.
    return {
        "categories": [
            {
                "key": "task_response",
                "score": 6.5,
                "feedback": "Réponse claire, mais naïve — café.",
            },
            {"key": "coherence_cohesion", "score": 6.0, "feedback": "Progression logique."},
            {"key": "lexical_resource", "score": 7.0, "feedback": "Bon éventail lexical."},
            {"key": "grammatical_range_accuracy", "score": 6.0, "feedback": "Quelques erreurs."},
        ],
        "grammar_corrections": [],
        "vocabulary_suggestions": [],
    }


async def test_score_survives_persist_and_readback_without_drift(db_conn, learner_profile_id):
    provider = FakeProvider([json.dumps(_payload_with_diacritics())])
    result = await evaluate_essay(
        provider,
        exam_type="ielts_academic",
        prompt_text="Some people think X. Discuss both views.",
        essay_text="In my view..." * 20,
        model="test-model",
        calibration_version="v1.0-launch",
    )

    session_id = await writing_repository.create_session(
        db_conn,
        learner_profile_id=learner_profile_id,
        exam_type="ielts_academic",
        prompt_text="Some people think X.",
        essay_text="In my view...",
        word_count=3,
    )
    await writing_repository.mark_processing(db_conn, session_id)
    await writing_repository.save_score(
        db_conn,
        session_id=session_id,
        overall_band_score=result.overall_band_score,
        cefr_level=result.cefr_level,
        calibration_version=result.calibration_version,
        categories=[
            {"name": c.name, "score": c.score, "weight": c.weight, "feedback": c.feedback}
            for c in result.categories
        ],
        grammar_corrections=None,
        vocabulary_suggestions=None,
    )

    row = await writing_repository.get_session_with_breakdown(db_conn, session_id)

    # Overall band: NUMERIC comes back as Decimal (never float), and the engine
    # quantizes it to 2dp — so the persisted representation is byte-identical.
    assert isinstance(row["overall_band_score"], Decimal)
    assert str(row["overall_band_score"]) == str(result.overall_band_score) == "6.50"
    assert row["cefr_level"] == result.cefr_level == "B2"
    assert row["calibration_version"] == "v1.0-launch"

    # Category slots preserved in order, values equal, still Decimal not float.
    for i, cat in enumerate(result.categories, start=1):
        assert row[f"category_{i}_name"] == cat.name
        assert isinstance(row[f"category_{i}_score"], Decimal)
        assert row[f"category_{i}_score"] == cat.score
        assert row[f"category_{i}_weight"] == cat.weight

    # Diacritics round-trip intact — the actual Ofqual failure mode.
    assert row["category_1_feedback"] == result.categories[0].feedback
    assert "naïve" in row["category_1_feedback"]
    assert "café" in row["category_1_feedback"]
