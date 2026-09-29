"""Unit tests for the --persist guard rails (Brief §9 sign-off is deliberate).

Pure decision logic — no DB, no network. A baseline is only ever born from a
green, single-exam, fully-specified run.
"""

from types import SimpleNamespace

from app.calibration.__main__ import _persist_precheck
from app.calibration.harness import CalibrationReport, CefrAgreement


def _passing_report(exam_type="ielts_academic") -> CalibrationReport:
    return CalibrationReport(
        exam_type=exam_type,
        sample_count=80,
        failed_count=0,
        overall_pearson=0.90,
        category_pearson={"task_response": 0.88},
        cefr_agreement=CefrAgreement(sample_count=80, exact_rate=0.8, adjacent_or_exact_rate=0.95),
    )


def _args(**overrides) -> SimpleNamespace:
    base = dict(
        calibration_version="v1.0-launch", examiner_count=2, kappa=0.87, signed_off_by="Lead"
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_precheck_passes_for_green_single_exam_run():
    assert _persist_precheck([_passing_report()], _args()) is None


def test_precheck_rejects_multiple_exam_types():
    reports = [_passing_report("ielts_academic"), _passing_report("ielts_general")]
    assert "one exam type at a time" in _persist_precheck(reports, _args())


def test_precheck_rejects_failing_gate():
    failing = CalibrationReport(
        exam_type="ielts_academic",
        sample_count=80,
        failed_count=0,
        overall_pearson=0.50,  # below the 0.85 gate
        category_pearson={},
        cefr_agreement=CefrAgreement(0, 0.0, 0.0),
    )
    assert "fails a writing gate" in _persist_precheck([failing], _args())


def test_precheck_requires_version():
    assert "calibration-version" in _persist_precheck(
        [_passing_report()], _args(calibration_version=None)
    )


def test_precheck_requires_examiner_count():
    assert "examiner-count" in _persist_precheck([_passing_report()], _args(examiner_count=None))
