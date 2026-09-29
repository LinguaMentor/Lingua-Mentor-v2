"""Calibration harness tests — scripted provider, no network."""

import json
from decimal import Decimal

import pytest

from app.calibration.harness import (
    CalibrationEssay,
    CalibrationReport,
    CefrAgreement,
    build_report,
    full_phase0_ready,
    load_dataset,
    pending_gates,
    run_calibration,
    score_dataset,
)
from tests.engines.writing_evaluation.test_engine import FakeProvider

pytestmark = pytest.mark.asyncio


def _payload(tr, cc, lr, gra):
    return json.dumps(
        {
            "categories": [
                {"key": "task_response", "score": tr, "feedback": "x"},
                {"key": "coherence_cohesion", "score": cc, "feedback": "x"},
                {"key": "lexical_resource", "score": lr, "feedback": "x"},
                {"key": "grammatical_range_accuracy", "score": gra, "feedback": "x"},
            ]
        }
    )


def _essay(essay_id, human_overall, categories, adversarial=False):
    return CalibrationEssay(
        essay_id=essay_id,
        exam_type="ielts_academic",
        prompt_text="p",
        essay_text="e",
        human_overall=Decimal(human_overall),
        human_categories={k: Decimal(v) for k, v in categories.items()},
        adversarial=adversarial,
    )


HUMAN_CATS = [
    {
        "task_response": "5.0",
        "coherence_cohesion": "5.0",
        "lexical_resource": "5.5",
        "grammatical_range_accuracy": "5.0",
    },
    {
        "task_response": "6.0",
        "coherence_cohesion": "6.0",
        "lexical_resource": "6.5",
        "grammatical_range_accuracy": "6.0",
    },
    {
        "task_response": "7.0",
        "coherence_cohesion": "7.0",
        "lexical_resource": "7.5",
        "grammatical_range_accuracy": "7.0",
    },
    {
        "task_response": "8.0",
        "coherence_cohesion": "8.0",
        "lexical_resource": "8.0",
        "grammatical_range_accuracy": "8.0",
    },
]


async def test_perfect_agreement_gives_r_1():
    """AI scores mirror human scores exactly → r = 1.0 overall and per category."""
    essays = [
        _essay("e1", "5.0", HUMAN_CATS[0]),
        _essay("e2", "6.0", HUMAN_CATS[1]),
        _essay("e3", "7.0", HUMAN_CATS[2]),
        _essay("e4", "8.0", HUMAN_CATS[3]),
    ]
    provider = FakeProvider(
        [
            _payload(5.0, 5.0, 5.5, 5.0),
            _payload(6.0, 6.0, 6.5, 6.0),
            _payload(7.0, 7.0, 7.5, 7.0),
            _payload(8.0, 8.0, 8.0, 8.0),
        ]
    )
    # concurrency=1 keeps the scripted responses aligned with essay order.
    scores, failures = await score_dataset(provider, essays, model="m", concurrency=1)
    assert failures == []
    report = build_report("ielts_academic", scores, 0)
    assert report.overall_pearson == pytest.approx(1.0)
    assert all(r == pytest.approx(1.0) for r in report.category_pearson.values())
    assert report.overall_gate_passed
    assert report.categories_below_gate == []
    assert report.divergent_essays == []


async def test_divergent_essays_flagged_and_failures_recorded():
    essays = [
        _essay("good", "5.0", HUMAN_CATS[0]),
        _essay("divergent", "6.0", HUMAN_CATS[1]),
        _essay("broken", "7.0", HUMAN_CATS[2]),
    ]
    provider = FakeProvider(
        [
            _payload(5.0, 5.0, 5.0, 5.0),
            _payload(8.0, 8.0, 8.0, 8.0),  # 2 bands above human → divergent
            "{malformed",
            "{still malformed",  # fails after retry → recorded failure
        ]
    )
    scores, failures = await score_dataset(provider, essays, model="m", concurrency=1)
    assert len(scores) == 2
    assert [f["essay_id"] for f in failures] == ["broken"]
    report = build_report("ielts_academic", scores, len(failures))
    assert [d["essay_id"] for d in report.divergent_essays] == ["divergent"]
    assert report.failed_count == 1


async def test_run_calibration_groups_by_exam_type(tmp_path):
    dataset = tmp_path / "essays.jsonl"
    records = [
        {
            "essay_id": "a",
            "exam_type": "ielts_academic",
            "prompt_text": "p",
            "essay_text": "e",
            "human_overall": "5.0",
            "human_categories": HUMAN_CATS[0],
        },
        {
            "essay_id": "b",
            "exam_type": "ielts_academic",
            "prompt_text": "p",
            "essay_text": "e",
            "human_overall": "7.0",
            "human_categories": HUMAN_CATS[2],
        },
    ]
    dataset.write_text("\n".join(json.dumps(r) for r in records))
    provider = FakeProvider([_payload(5.0, 5.0, 5.5, 5.0), _payload(7.0, 7.0, 7.5, 7.0)])
    reports = await run_calibration(provider, dataset, model="m", concurrency=1)
    assert len(reports) == 1
    assert reports[0].exam_type == "ielts_academic"
    assert reports[0].sample_count == 2


def test_load_dataset_reports_bad_line(tmp_path):
    dataset = tmp_path / "bad.jsonl"
    dataset.write_text('{"essay_id": "a"}\n')
    with pytest.raises(ValueError, match="bad.jsonl:1"):
        load_dataset(dataset)


# --- Adversarial gate (ADR 0006 §2.1) ------------------------------------


async def test_adversarial_overscore_fails_gate():
    """A gamed essay the AI scores >0.5 band above the human fails the hard gate
    and is held out of the Pearson correlation."""
    essays = [
        _essay("e1", "5.0", HUMAN_CATS[0]),
        _essay("e2", "7.0", HUMAN_CATS[2]),
        _essay("gamed", "4.0", HUMAN_CATS[0], adversarial=True),
    ]
    provider = FakeProvider(
        [
            _payload(5.0, 5.0, 5.0, 5.0),
            _payload(7.0, 7.0, 7.0, 7.0),
            _payload(6.0, 6.0, 6.0, 6.0),  # ai 6.0 vs human 4.0 → +2.0 band
        ]
    )
    scores, _ = await score_dataset(provider, essays, model="m", concurrency=1)
    report = build_report("ielts_academic", scores, 0)

    assert report.sample_count == 2  # adversarial excluded from the correlation
    assert report.adversarial_count == 1
    assert report.overall_pearson == pytest.approx(1.0)  # excluded → r stays 1.0
    assert report.adversarial_gate_passed is False
    assert [o["essay_id"] for o in report.adversarial_overscored] == ["gamed"]
    assert report.writing_gates_passed is False  # one hard gate failed


async def test_adversarial_within_margin_passes_gate():
    """Half a band of over-scoring is the tolerance, not a failure."""
    essays = [
        _essay("e1", "5.0", HUMAN_CATS[0]),
        _essay("e2", "7.0", HUMAN_CATS[2]),
        _essay("gamed", "4.0", HUMAN_CATS[0], adversarial=True),
    ]
    provider = FakeProvider(
        [
            _payload(5.0, 5.0, 5.0, 5.0),
            _payload(7.0, 7.0, 7.0, 7.0),
            _payload(4.5, 4.5, 4.5, 4.5),  # ai 4.5 vs human 4.0 → +0.5, at the margin
        ]
    )
    scores, _ = await score_dataset(provider, essays, model="m", concurrency=1)
    report = build_report("ielts_academic", scores, 0)

    assert report.adversarial_gate_passed is True
    assert report.adversarial_overscored == []
    assert report.writing_gates_passed is True  # pearson + cefr + adversarial all pass


# --- Boundary-aware CEFR agreement (ADR 0006 §2.5) -----------------------


async def test_cefr_agreement_exact_adjacent_and_far_miss():
    """Exact and adjacent CEFR matches both count toward the tolerant gate; a
    multi-level miss does not — and a run with too many far misses fails."""
    essays = [
        _essay("exact", "7.0", HUMAN_CATS[2]),  # human C1
        _essay("adjacent", "6.5", HUMAN_CATS[1]),  # human B2
        _essay("far", "8.5", HUMAN_CATS[3]),  # human C2
    ]
    provider = FakeProvider(
        [
            _payload(7.0, 7.0, 7.0, 7.0),  # ai 7.0 → C1 (exact vs C1)
            _payload(7.0, 7.0, 7.0, 7.0),  # ai 7.0 → C1 (adjacent vs B2)
            _payload(5.0, 5.0, 5.0, 5.0),  # ai 5.0 → B1 (far vs C2)
        ]
    )
    scores, _ = await score_dataset(provider, essays, model="m", concurrency=1)
    report = build_report("ielts_academic", scores, 0)

    assert report.cefr_agreement.sample_count == 3
    assert report.cefr_agreement.exact_rate == pytest.approx(1 / 3)
    assert report.cefr_agreement.adjacent_or_exact_rate == pytest.approx(2 / 3)
    assert report.cefr_agreement.gate_passed is False  # 0.667 < 0.90
    assert report.writing_gates_passed is False


# --- Interim iteration budget (ADR 0006 §2.3) ----------------------------


def _bare_report(overall_pearson: float) -> CalibrationReport:
    return CalibrationReport(
        exam_type="ielts_academic",
        sample_count=2,
        failed_count=0,
        overall_pearson=overall_pearson,
        category_pearson={},
        cefr_agreement=CefrAgreement(0, 0.0, 0.0),
    )


def test_gate_status_tiers():
    assert _bare_report(0.90).gate_status == "PASS"
    assert _bare_report(0.85).gate_status == "PASS"  # gate is inclusive
    assert _bare_report(0.80).gate_status == "ITERATE"
    assert _bare_report(0.75).gate_status == "ITERATE"  # interim gate inclusive
    assert _bare_report(0.74).gate_status == "STRUCTURAL"


# --- Partial-vs-full Phase 0 status (ADR 0006 §2.2) ----------------------


def test_wer_gate_pending_means_phase0_not_full():
    """WER is unbuilt (Phase 2), so a green writing run is never a full Phase 0
    pass — the manifest surfaces the outstanding gate explicitly."""
    assert full_phase0_ready() is False
    assert [g.key for g in pending_gates()] == ["wer_pronunciation"]
