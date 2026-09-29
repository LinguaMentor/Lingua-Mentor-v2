"""Inter-rater reliability + consensus resolution for Phase 0 datasets.

The calibration harness scores a *clean* dataset: one consensus human score per
essay. This module produces that clean dataset from the raw output of the
grading protocol — two (sometimes three) independent examiner scores per essay —
and gates it on inter-rater reliability before it's allowed to inform a
Go/No-Go. Bad human data corrupts calibration just as surely as a bad model
(Brief §6.1; Ofqual precedent, ADR 0006 §2.4).

Two things happen here, per exam type:

1. **Consensus resolution** (Calibration Brief §6.1, as amended v1.1 §6.1):
   the two graders' agreement decides the consensus —
     - within 0.5 band          → arithmetic average, entered directly;
     - >0.5 to 1.0 band          → average, flagged `spot_review` (enters the
       dataset now; a Lead Examiner check must clear before final sign-off);
     - >1.0 band                 → a third adjudicator is required; consensus is
       the adjudicator's score reconciled with whichever original it is closer
       to (the two-way average of adjudicator + nearer rater, dropping the
       outlier — *not* a three-way average).
   Disagreement is measured as the largest gap across the overall band *and*
   any shared rubric category — a >1.0 category gap triggers adjudication even
   when the overall bands agree (Brief §3.2).

2. **Reliability gate** (Brief §6.1): dataset-level agreement between the two
   primary graders must reach ≥0.80 or the set isn't trustworthy enough to
   calibrate against. For the continuous IELTS band scale this is Pearson r on
   the two graders' overall scores. (Discrete-grid exams — DELF /25 tiers, TCF
   /20 — want *weighted* kappa instead, since Pearson under-reads agreement on
   compressed ordinal scales; that path lands with the ordinal engine, ADR 0002.
   Until then those exam types are deferred here, not mis-scored as continuous.)

Scope: only the live continuous-band exams (IELTS Academic/General) are
processed. DELF/DALF, TCF, and the retired-then-rebuilt TOEFL are recognised and
deferred with a reason (ADR 0002 / ADR 0003), never silently run through the
band logic their scales don't fit.
"""

import json
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from pydantic import BaseModel, Field

from app.calibration.harness import pearson

# Dataset-level human-human agreement floor (Brief §6.1).
IRR_GATE = 0.80
# Band-gap thresholds for consensus (Brief §3.2 / amended §6.1).
SPOT_REVIEW_BAND = Decimal("0.5")
ADJUDICATION_BAND = Decimal("1.0")

# The exams whose scale the continuous band logic here actually fits. Everything
# else is deferred, not force-fit (see module docstring).
CONTINUOUS_LIVE_EXAMS = frozenset({"ielts_academic", "ielts_general"})

# Normalise raw task-level exam ids to the config exam_id the engine keys on.
# Data-contract normalisation only — unknown ids pass through unchanged.
EXAM_TYPE_ALIASES = {
    "ielts_academic_task2": "ielts_academic",
    "ielts_general_task2": "ielts_general",
}


def normalize_exam_type(exam_type: str) -> str:
    return EXAM_TYPE_ALIASES.get(exam_type, exam_type)


def _defer_reason(normalized: str, raw: dict) -> str | None:
    """Why an exam type can't be ingested as continuous yet, or None if it can."""
    if normalized in CONTINUOUS_LIVE_EXAMS:
        return None
    if "rater_1_tiers" in raw or "rater_1_overall_25" in raw:
        return "DELF/DALF ordinal /25 grid — weighted-kappa path lands with ADR 0002"
    if "rater_1_overall_20" in raw:
        return "TCF /20 scale — engine and ordinal path not built yet (ADR 0002)"
    if normalized.startswith("toefl"):
        return "TOEFL non-production until 2026 rebuild (ADR 0003)"
    return f"no live continuous-band engine for '{normalized}'"


class RawGradedEssay(BaseModel):
    """One essay as it leaves the grading protocol: two independent scores,
    plus a third adjudicating score when the two diverged past a full band."""

    essay_id: str
    exam_type: str
    prompt_text: str = ""
    essay_text: str = ""
    adversarial: bool = False
    rater_1_overall: Decimal
    rater_2_overall: Decimal
    rater_1_categories: dict[str, Decimal] = Field(default_factory=dict)
    rater_2_categories: dict[str, Decimal] = Field(default_factory=dict)
    adjudicated: bool = False
    adjudicator_overall: Decimal | None = None
    adjudicator_categories: dict[str, Decimal] | None = None


@dataclass
class Consensus:
    status: str  # "resolved" | "excluded"
    overall: Decimal | None = None
    categories: dict[str, Decimal] = field(default_factory=dict)
    flag: str | None = None  # None | "spot_review" | "adjudicated"
    reason: str | None = None  # set when status == "excluded"


def _avg(a: Decimal, b: Decimal) -> Decimal:
    return (a + b) / 2


def _max_disagreement(essay: RawGradedEssay) -> Decimal:
    """Largest gap across the overall band and any shared rubric category — a
    big category gap triggers adjudication even if the overall bands agree."""
    gaps = [abs(essay.rater_1_overall - essay.rater_2_overall)]
    for key in set(essay.rater_1_categories) & set(essay.rater_2_categories):
        gaps.append(abs(essay.rater_1_categories[key] - essay.rater_2_categories[key]))
    return max(gaps)


def resolve_consensus(essay: RawGradedEssay) -> Consensus:
    shared = set(essay.rater_1_categories) & set(essay.rater_2_categories)
    max_gap = _max_disagreement(essay)

    if max_gap > ADJUDICATION_BAND:
        if not essay.adjudicated or essay.adjudicator_overall is None:
            return Consensus(
                status="excluded",
                reason=(
                    f"graders diverge by {max_gap} band (>1.0) — adjudication required but absent"
                ),
            )
        # Drop the outlier: reconcile the adjudicator with the nearer rater.
        adj = essay.adjudicator_overall
        near_is_1 = abs(adj - essay.rater_1_overall) <= abs(adj - essay.rater_2_overall)
        nearer_overall = essay.rater_1_overall if near_is_1 else essay.rater_2_overall
        nearer_cats = essay.rater_1_categories if near_is_1 else essay.rater_2_categories
        categories = {}
        if essay.adjudicator_categories:
            categories = {
                k: _avg(v, nearer_cats[k])
                for k, v in essay.adjudicator_categories.items()
                if k in nearer_cats
            }
        return Consensus(
            status="resolved",
            overall=_avg(adj, nearer_overall),
            categories=categories,
            flag="adjudicated",
        )

    categories = {k: _avg(essay.rater_1_categories[k], essay.rater_2_categories[k]) for k in shared}
    consensus_overall = _avg(essay.rater_1_overall, essay.rater_2_overall)
    # >0.5 to 1.0: usable now, but the Lead Examiner must clear it before sign-off.
    flag = "spot_review" if max_gap > SPOT_REVIEW_BAND else None
    return Consensus(status="resolved", overall=consensus_overall, categories=categories, flag=flag)


@dataclass
class IngestionResult:
    clean_essays: list[dict]
    irr_overall: float | None
    irr_per_category: dict[str, float]
    processed_count: int
    excluded: list[dict] = field(default_factory=list)
    spot_review_ids: list[str] = field(default_factory=list)
    adjudicated_ids: list[str] = field(default_factory=list)
    deferred: list[dict] = field(default_factory=list)

    @property
    def irr_gate_passed(self) -> bool:
        return self.irr_overall is not None and self.irr_overall >= IRR_GATE

    @property
    def ready(self) -> bool:
        """A clean, trustworthy, complete dataset: reliability met and nothing
        stuck awaiting adjudication."""
        return self.irr_gate_passed and not self.excluded


def _compute_irr(essays: list[RawGradedEssay]) -> tuple[float | None, dict[str, float]]:
    """Agreement between the two primary graders across the whole set. Includes
    high-disagreement and adversarial essays — excluding them would flatter the
    reliability figure. Needs ≥2 essays with two overall scores."""
    if len(essays) < 2:
        return None, {}
    overall = pearson(
        [float(e.rater_1_overall) for e in essays],
        [float(e.rater_2_overall) for e in essays],
    )
    per_category: dict[str, float] = {}
    all_keys = sorted(
        {k for e in essays for k in (set(e.rater_1_categories) & set(e.rater_2_categories))}
    )
    for key in all_keys:
        pairs = [
            (float(e.rater_1_categories[key]), float(e.rater_2_categories[key]))
            for e in essays
            if key in e.rater_1_categories and key in e.rater_2_categories
        ]
        if len(pairs) >= 2:
            per_category[key] = pearson([p[0] for p in pairs], [p[1] for p in pairs])
    return overall, per_category


def ingest(records: list[dict]) -> IngestionResult:
    """Turn raw per-rater records into a clean, IRR-gated calibration dataset."""
    processed: list[RawGradedEssay] = []
    deferred: list[dict] = []
    for raw in records:
        normalized = normalize_exam_type(raw.get("exam_type", ""))
        reason = _defer_reason(normalized, raw)
        if reason is not None:
            deferred.append(
                {
                    "essay_id": raw.get("essay_id"),
                    "exam_type": raw.get("exam_type"),
                    "reason": reason,
                }
            )
            continue
        essay = RawGradedEssay.model_validate(raw)
        essay.exam_type = normalized
        processed.append(essay)

    clean: list[dict] = []
    excluded: list[dict] = []
    spot_review_ids: list[str] = []
    adjudicated_ids: list[str] = []
    for essay in processed:
        consensus = resolve_consensus(essay)
        if consensus.status == "excluded":
            excluded.append({"essay_id": essay.essay_id, "reason": consensus.reason})
            continue
        if consensus.flag == "spot_review":
            spot_review_ids.append(essay.essay_id)
        elif consensus.flag == "adjudicated":
            adjudicated_ids.append(essay.essay_id)
        clean.append(
            {
                "essay_id": essay.essay_id,
                "exam_type": essay.exam_type,
                "prompt_text": essay.prompt_text,
                "essay_text": essay.essay_text,
                "human_overall": str(consensus.overall),
                "human_categories": {k: str(v) for k, v in consensus.categories.items()},
                "adversarial": essay.adversarial,
            }
        )

    irr_overall, irr_per_category = _compute_irr(processed)
    return IngestionResult(
        clean_essays=clean,
        irr_overall=irr_overall,
        irr_per_category=irr_per_category,
        processed_count=len(processed),
        excluded=excluded,
        spot_review_ids=spot_review_ids,
        adjudicated_ids=adjudicated_ids,
        deferred=deferred,
    )


def load_raw_dataset(path: Path) -> list[dict]:
    records = []
    with path.open() as f:
        for line_number, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {exc}") from exc
    return records
