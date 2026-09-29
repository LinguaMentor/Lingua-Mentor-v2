"""Phase 0 calibration harness (Calibration Brief §6, Master PRD §60).

Runs the Writing Evaluation Engine over a human-graded essay dataset and
computes Pearson correlation — overall and per rubric category — against the
Go/No-Go gates:

    overall  >= 0.85   hard gate
    category >= 0.80   soft gate (flags the category for rubric tuning)

Around that Pearson core sit three further hard checks (ADR 0006):

  * an adversarial gate — bad-faith "gamed" essays (keyword stuffing, repeated
    paragraphs, sophisticated-but-empty prose) must not be over-scored relative
    to the human judgement (§2.1);
  * a boundary-aware CEFR agreement metric — exact and adjacent-or-exact rates,
    because the IELTS↔CEFR mapping is genuinely fuzzy at boundaries (the C1
    threshold falls between bands 6.5 and 7), so a flat accuracy number scores
    inherent labeller disagreement as model error (§2.5);
  * a partial-vs-full status — WER/pronunciation is a required gate that cannot
    be built until the ASR path exists (Phase 2), so this harness reports the
    *writing* gate only and says so, never a full Phase 0 GO (§2.2).

Dataset format: JSONL, one essay per line:
    {"essay_id": "...", "exam_type": "ielts_academic",
     "prompt_text": "...", "essay_text": "...",
     "human_overall": 6.5,
     "human_categories": {"task_response": 6.0, ...},
     "adversarial": false}

`human_overall` is the examiner-consensus score. The redundancy behind that
consensus is per-exam, not a flat "two examiners": DELF/DALF/TCF use mandatory
double-blind marking, whereas live IELTS is single-examiner with statistical
"jagged profile" flagging (ADR 0006 §2.5). Whatever the source, essays failing
inter-rater reliability must be excluded *before* they reach this file. Always
re-run against the full dataset after rubric tuning — never a subset
(Brief §6.2 warning). `adversarial` defaults to false when absent.
"""

import asyncio
import json
import statistics
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from pydantic import BaseModel

from app.engines.writing_evaluation import evaluate_essay, load_exam_config
from app.providers.llm.base import LLMProvider

OVERALL_GATE = 0.85
CATEGORY_GATE = 0.80
# ADR 0006 §2.3: at/above this interim mark a sub-0.85 run is within the tuning
# budget (iterate); below it is a structural miss. Never lowers the launch gate.
INTERIM_GATE = 0.75
# ADR 0006 §2.1: one-sided gate — a gamed essay must not score >0.5 band above
# the human's; under-scoring bad faith is fine (Stumping-e-rater failure mode).
ADVERSARIAL_MARGIN = Decimal("0.5")
# ADR 0006 §2.5: adjacent-or-exact CEFR agreement, not flat accuracy — a one-
# level miss at a fuzzy band boundary isn't model error.
CEFR_GATE = 0.90
# Brief §6.2 step 2: >1-band AI/human divergences are the review set. Adversarial
# essays are excluded — they're meant to diverge and would drown the signal.
DIVERGENCE_THRESHOLD = Decimal("1.0")

# CEFR ladder for adjacency arithmetic. Below the lowest threshold maps to None
# (`cefr_for`), ranked just under A1 — adjacent to A1 but not A2.
_CEFR_SCALE = ("A1", "A2", "B1", "B2", "C1", "C2")


def _cefr_rank(level: str | None) -> int:
    return _CEFR_SCALE.index(level) if level in _CEFR_SCALE else -1


@dataclass(frozen=True)
class Phase0Gate:
    """One Go/No-Go criterion and whether it can run in the current codebase.

    `implemented=False` is the mechanism that stops a writing-only pass from
    masquerading as a full Phase 0 pass (ADR 0006 §2.2): the manifest carries
    the unbuilt gates explicitly rather than omitting them silently.
    """

    key: str
    description: str
    implemented: bool
    note: str = ""


# The full Go/No-Go surface. WER stays here marked unimplemented (needs the
# Phase 2 ASR path) so its absence shows on every report (ADR 0006 §2.2).
PHASE0_GATES: tuple[Phase0Gate, ...] = (
    Phase0Gate("pearson_overall", "AI↔human overall Pearson r >= 0.85", True),
    Phase0Gate(
        "pearson_category",
        "Per-category Pearson r >= 0.80 (soft — flags a rubric for tuning)",
        True,
    ),
    Phase0Gate(
        "adversarial",
        f"Gamed responses not over-scored by more than {ADVERSARIAL_MARGIN} band",
        True,
    ),
    Phase0Gate(
        "cefr_boundary",
        f"Boundary-aware CEFR agreement (adjacent-or-exact) >= {CEFR_GATE}",
        True,
    ),
    Phase0Gate(
        "pipeline_integrity",
        "Engine→persist→report round-trip introduces zero score drift",
        True,
        "asserted by tests/calibration/test_pipeline_integrity.py (ADR 0006 §2.4)",
    ),
    Phase0Gate(
        "wer_pronunciation",
        "Speech WER < 10% per accent target",
        False,
        "pending Phase 2 — depends on the ASR path (ADR 0006 §2.2)",
    ),
)


def full_phase0_ready() -> bool:
    """False while any Go/No-Go gate is still unimplemented — i.e. a green run
    of the implemented gates is a *writing* pass, not a full Phase 0 pass."""
    return all(g.implemented for g in PHASE0_GATES)


def pending_gates() -> list[Phase0Gate]:
    return [g for g in PHASE0_GATES if not g.implemented]


class CalibrationEssay(BaseModel):
    essay_id: str
    exam_type: str
    prompt_text: str
    essay_text: str
    human_overall: Decimal
    human_categories: dict[str, Decimal]
    # A bad-faith essay authored to probe scoring shortcuts (ADR 0006 §2.1).
    # Routed to the adversarial gate, kept out of the Pearson correlation.
    adversarial: bool = False


@dataclass
class EssayScore:
    essay_id: str
    human_overall: Decimal
    ai_overall: Decimal
    human_categories: dict[str, Decimal]
    ai_categories: dict[str, Decimal]
    adversarial: bool = False

    @property
    def delta(self) -> Decimal:
        """Unsigned gap — for the divergence review set."""
        return abs(self.ai_overall - self.human_overall)

    @property
    def overscore(self) -> Decimal:
        """Signed AI-minus-human — positive means the AI scored it higher."""
        return self.ai_overall - self.human_overall


@dataclass
class CefrAgreement:
    """Boundary-aware CEFR classification agreement (ADR 0006 §2.5)."""

    sample_count: int
    exact_rate: float
    adjacent_or_exact_rate: float

    @property
    def gate_passed(self) -> bool:
        # Empty sample passes vacuously so a subset with no gradable CEFR pairs
        # can't wedge the run — the Pearson gate is the real backstop.
        return self.sample_count == 0 or self.adjacent_or_exact_rate >= CEFR_GATE


@dataclass
class CalibrationReport:
    exam_type: str
    sample_count: int  # normal essays scored (adversarial excluded)
    failed_count: int
    overall_pearson: float
    category_pearson: dict[str, float]
    cefr_agreement: CefrAgreement
    adversarial_count: int = 0
    adversarial_overscored: list[dict] = field(default_factory=list)
    divergent_essays: list[dict] = field(default_factory=list)

    @property
    def overall_gate_passed(self) -> bool:
        return self.overall_pearson >= OVERALL_GATE

    @property
    def adversarial_gate_passed(self) -> bool:
        return not self.adversarial_overscored

    @property
    def gate_status(self) -> str:
        """PASS / ITERATE / STRUCTURAL for the Pearson dimension (ADR 0006 §2.3)."""
        if self.overall_pearson >= OVERALL_GATE:
            return "PASS"
        if self.overall_pearson >= INTERIM_GATE:
            return "ITERATE"
        return "STRUCTURAL"

    @property
    def writing_gates_passed(self) -> bool:
        """Every *implemented* hard gate for the writing line. Not a full Phase
        0 pass while `pending_gates()` is non-empty (WER) — see §2.2."""
        return (
            self.overall_gate_passed
            and self.adversarial_gate_passed
            and self.cefr_agreement.gate_passed
        )

    @property
    def categories_below_gate(self) -> list[str]:
        return sorted(key for key, r in self.category_pearson.items() if r < CATEGORY_GATE)

    def to_dict(self) -> dict:
        return {
            "exam_type": self.exam_type,
            "sample_count": self.sample_count,
            "failed_count": self.failed_count,
            "overall_pearson": round(self.overall_pearson, 4),
            "overall_gate": OVERALL_GATE,
            "overall_gate_passed": self.overall_gate_passed,
            "gate_status": self.gate_status,
            "category_pearson": {k: round(v, 4) for k, v in self.category_pearson.items()},
            "category_gate": CATEGORY_GATE,
            "categories_below_gate": self.categories_below_gate,
            "cefr_agreement": {
                "sample_count": self.cefr_agreement.sample_count,
                "exact_rate": round(self.cefr_agreement.exact_rate, 4),
                "adjacent_or_exact_rate": round(self.cefr_agreement.adjacent_or_exact_rate, 4),
                "gate": CEFR_GATE,
                "gate_passed": self.cefr_agreement.gate_passed,
            },
            "adversarial": {
                "count": self.adversarial_count,
                "margin": str(ADVERSARIAL_MARGIN),
                "gate_passed": self.adversarial_gate_passed,
                "overscored": self.adversarial_overscored,
            },
            "divergent_essays": self.divergent_essays,
            "writing_gates_passed": self.writing_gates_passed,
        }


def load_dataset(path: Path) -> list[CalibrationEssay]:
    essays = []
    with path.open() as f:
        for line_number, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                essays.append(CalibrationEssay.model_validate(json.loads(line)))
            except Exception as exc:  # noqa: BLE001 — surface the line number
                raise ValueError(f"{path}:{line_number}: invalid essay record: {exc}") from exc
    return essays


def pearson(xs: list[float], ys: list[float]) -> float:
    """Pearson r via stdlib. Needs >= 2 points and nonzero variance."""
    if len(xs) < 2:
        raise ValueError("Pearson correlation needs at least 2 samples")
    return statistics.correlation(xs, ys)


async def score_dataset(
    provider: LLMProvider,
    essays: list[CalibrationEssay],
    *,
    model: str,
    concurrency: int = 4,
) -> tuple[list[EssayScore], list[dict]]:
    """Score every essay; collect failures instead of aborting the run —
    a 100-essay run shouldn't die at essay 97."""
    semaphore = asyncio.Semaphore(concurrency)
    failures: list[dict] = []

    async def score_one(essay: CalibrationEssay) -> EssayScore | None:
        async with semaphore:
            try:
                result = await evaluate_essay(
                    provider,
                    exam_type=essay.exam_type,
                    prompt_text=essay.prompt_text,
                    essay_text=essay.essay_text,
                    model=model,
                )
            except Exception as exc:  # noqa: BLE001 — recorded per essay
                failures.append({"essay_id": essay.essay_id, "error": str(exc)})
                return None
        return EssayScore(
            essay_id=essay.essay_id,
            human_overall=essay.human_overall,
            ai_overall=result.overall_band_score,
            human_categories=essay.human_categories,
            ai_categories={c.key: c.score for c in result.categories},
            adversarial=essay.adversarial,
        )

    scored = await asyncio.gather(*(score_one(e) for e in essays))
    return [s for s in scored if s is not None], failures


def _cefr_agreement(exam_type: str, scores: list[EssayScore]) -> CefrAgreement:
    """Map both human and AI overall scores through the exam's own CEFR
    thresholds and measure agreement with one-level tolerance (ADR 0006 §2.5)."""
    config = load_exam_config(exam_type)
    if not scores:
        return CefrAgreement(sample_count=0, exact_rate=0.0, adjacent_or_exact_rate=0.0)
    exact = 0
    adjacent = 0
    for s in scores:
        human_rank = _cefr_rank(config.writing.cefr_for(s.human_overall))
        ai_rank = _cefr_rank(config.writing.cefr_for(s.ai_overall))
        if ai_rank == human_rank:
            exact += 1
            adjacent += 1
        elif abs(ai_rank - human_rank) <= 1:
            adjacent += 1
    n = len(scores)
    return CefrAgreement(
        sample_count=n,
        exact_rate=exact / n,
        adjacent_or_exact_rate=adjacent / n,
    )


def build_report(exam_type: str, scores: list[EssayScore], failed_count: int) -> CalibrationReport:
    # Adversarial essays are held out of every correlation/agreement metric —
    # they exist to probe over-scoring, not to measure fidelity (ADR 0006 §2.1).
    normal = [s for s in scores if not s.adversarial]
    adversarial = [s for s in scores if s.adversarial]

    overall = pearson(
        [float(s.human_overall) for s in normal],
        [float(s.ai_overall) for s in normal],
    )
    category_keys = sorted(normal[0].ai_categories) if normal else []
    category_pearson = {}
    for key in category_keys:
        pairs = [
            (float(s.human_categories[key]), float(s.ai_categories[key]))
            for s in normal
            if key in s.human_categories
        ]
        if len(pairs) >= 2:
            category_pearson[key] = pearson([p[0] for p in pairs], [p[1] for p in pairs])

    overscored = sorted(
        (s for s in adversarial if s.overscore > ADVERSARIAL_MARGIN),
        key=lambda s: s.overscore,
        reverse=True,
    )
    divergent = sorted(
        (s for s in normal if s.delta > DIVERGENCE_THRESHOLD),
        key=lambda s: s.delta,
        reverse=True,
    )
    return CalibrationReport(
        exam_type=exam_type,
        sample_count=len(normal),
        failed_count=failed_count,
        overall_pearson=overall,
        category_pearson=category_pearson,
        cefr_agreement=_cefr_agreement(exam_type, normal),
        adversarial_count=len(adversarial),
        adversarial_overscored=[
            {
                "essay_id": s.essay_id,
                "human": str(s.human_overall),
                "ai": str(s.ai_overall),
                "overscore": str(s.overscore),
            }
            for s in overscored
        ],
        divergent_essays=[
            {
                "essay_id": s.essay_id,
                "human": str(s.human_overall),
                "ai": str(s.ai_overall),
                "delta": str(s.delta),
            }
            for s in divergent
        ],
    )


async def run_calibration(
    provider: LLMProvider,
    dataset_path: Path,
    *,
    model: str,
    concurrency: int = 4,
) -> list[CalibrationReport]:
    """One report per exam_type present in the dataset (gates apply per exam
    type — Brief §9: a partial pass is a no-go)."""
    essays = load_dataset(dataset_path)
    reports = []
    for exam_type in sorted({e.exam_type for e in essays}):
        subset = [e for e in essays if e.exam_type == exam_type]
        scores, failures = await score_dataset(
            provider, subset, model=model, concurrency=concurrency
        )
        reports.append(build_report(exam_type, scores, len(failures)))
    return reports
