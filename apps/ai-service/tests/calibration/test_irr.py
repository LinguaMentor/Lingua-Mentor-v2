"""Tests for IRR ingestion: consensus resolution + reliability gate + deferral.

Pure logic, no DB/network. Mirrors the amended Brief §6.1 band rules and the
adjudication trigger from the grading protocol (a >1.0 *category* gap adjudicates
even when the overall bands agree).
"""

from decimal import Decimal

from app.calibration.harness import load_dataset
from app.calibration.irr import (
    RawGradedEssay,
    ingest,
    resolve_consensus,
)


def _raw(**overrides) -> RawGradedEssay:
    base = dict(
        essay_id="e",
        exam_type="ielts_academic",
        rater_1_overall=Decimal("6.5"),
        rater_2_overall=Decimal("6.5"),
        rater_1_categories={"task_response": Decimal("6.5")},
        rater_2_categories={"task_response": Decimal("6.5")},
    )
    base.update(overrides)
    return RawGradedEssay(**base)


# --- Consensus band rules (amended Brief §6.1) ---------------------------


def test_within_half_band_averages_without_flag():
    c = resolve_consensus(
        _raw(
            rater_1_overall=Decimal("6.5"),
            rater_2_overall=Decimal("7.0"),
            rater_1_categories={"task_response": Decimal("6.5")},
            rater_2_categories={"task_response": Decimal("7.0")},
        )
    )
    assert c.status == "resolved"
    assert c.flag is None
    assert c.overall == Decimal("6.75")


def test_half_to_one_band_flags_spot_review():
    c = resolve_consensus(
        _raw(
            rater_1_overall=Decimal("6.0"),
            rater_2_overall=Decimal("7.0"),
            rater_1_categories={"task_response": Decimal("6.0")},
            rater_2_categories={"task_response": Decimal("7.0")},
        )
    )
    assert c.flag == "spot_review"
    assert c.overall == Decimal("6.5")


def test_category_gap_over_one_band_triggers_adjudication_even_if_overall_agrees():
    # Overall bands are only 0.5 apart, but task_response is 2.0 apart — adjudicate.
    c = resolve_consensus(
        _raw(
            rater_1_overall=Decimal("5.75"),
            rater_2_overall=Decimal("6.25"),
            rater_1_categories={"task_response": Decimal("5.0")},
            rater_2_categories={"task_response": Decimal("7.0")},
            adjudicated=True,
            adjudicator_overall=Decimal("6.0"),
            adjudicator_categories={"task_response": Decimal("6.0")},
        )
    )
    assert c.flag == "adjudicated"
    # adjudicator (6.0) reconciled with the nearer rater (r1 5.75) — two-way avg.
    assert c.overall == Decimal("5.875")
    assert c.categories["task_response"] == Decimal("5.5")  # (6.0 + 5.0) / 2


def test_over_one_band_without_adjudication_is_excluded():
    c = resolve_consensus(
        _raw(
            rater_1_overall=Decimal("5.0"),
            rater_2_overall=Decimal("7.0"),
            rater_1_categories={"task_response": Decimal("5.0")},
            rater_2_categories={"task_response": Decimal("7.0")},
        )
    )
    assert c.status == "excluded"
    assert "adjudication required" in c.reason


# --- Reliability gate + full ingest --------------------------------------


def _record(essay_id, r1, r2, exam="ielts_academic"):
    return {
        "essay_id": essay_id,
        "exam_type": exam,
        "prompt_text": "p",
        "essay_text": "e",
        "rater_1_overall": r1,
        "rater_2_overall": r2,
        "rater_1_categories": {"task_response": r1},
        "rater_2_categories": {"task_response": r2},
    }


def test_ingest_computes_reliability_and_emits_clean_set():
    records = [
        _record("a", "5.0", "5.5"),
        _record("b", "6.0", "6.5"),
        _record("c", "7.0", "7.0"),
        _record("d", "8.0", "7.5"),
    ]
    result = ingest(records)
    assert result.processed_count == 4
    assert len(result.clean_essays) == 4
    assert result.irr_overall is not None and result.irr_overall >= 0.80
    assert result.irr_gate_passed
    assert result.ready
    # Consensus is the two-grader average, entered directly.
    assert result.clean_essays[0]["human_overall"] == "5.25"


def test_ingest_excluded_essay_blocks_ready():
    records = [
        _record("a", "5.0", "5.5"),
        _record("b", "6.0", "6.5"),
        _record("bad", "5.0", "7.0"),  # 2.0 gap, no adjudication → excluded
    ]
    result = ingest(records)
    assert [e["essay_id"] for e in result.excluded] == ["bad"]
    assert len(result.clean_essays) == 2
    assert result.ready is False  # a stuck essay blocks readiness even if IRR passes


def test_ingest_normalizes_task_level_exam_id():
    result = ingest(
        [
            _record("a", "6.0", "6.5", exam="ielts_academic_task2"),
            _record("b", "7.0", "7.0", exam="ielts_academic_task2"),
        ]
    )
    assert {e["exam_type"] for e in result.clean_essays} == {"ielts_academic"}


def test_ingest_defers_non_continuous_exams():
    records = [
        {
            "essay_id": "delf1",
            "exam_type": "delf_b2_production_ecrite",
            "rater_1_tiers": {"realisation_tache": 3},
            "rater_1_overall_25": 13,
        },
        {
            "essay_id": "tcf1",
            "exam_type": "tcf_canada_expression_ecrite",
            "rater_1_overall_20": 12,
            "rater_2_overall_20": 13,
        },
        {
            "essay_id": "toefl1",
            "exam_type": "toefl_write_an_email",
            "rater_1_overall": "3.0",
            "rater_2_overall": "3.5",
            "rater_1_categories": {},
            "rater_2_categories": {},
        },
    ]
    result = ingest(records)
    assert result.processed_count == 0
    assert {d["essay_id"] for d in result.deferred} == {"delf1", "tcf1", "toefl1"}


def test_clean_output_round_trips_through_the_harness_loader(tmp_path):
    import json

    records = [_record("a", "5.0", "5.5"), _record("b", "7.0", "7.5")]
    result = ingest(records)
    dataset = tmp_path / "clean.jsonl"
    dataset.write_text("\n".join(json.dumps(e) for e in result.clean_essays) + "\n")
    # The harness must be able to parse exactly what ingestion emits.
    essays = load_dataset(dataset)
    assert [e.essay_id for e in essays] == ["a", "b"]
    assert essays[0].human_overall == Decimal("5.25")
