"""Skill-level spaced repetition (Master PRD §23.3, ADR 0008).

SRS here schedules *skill dimensions*, not vocabulary cards: which of the
learner's skills has decayed enough to be worth the next session. Pure
functions — the caller supplies state and persists whatever comes back.
"""

import statistics
from dataclasses import dataclass
from datetime import UTC, datetime

# Phase 1 practises writing only, so pronunciation/fluency stay out until the
# Voice Agent lands and comprehension has no SRS columns at all (ADR 0008 §2.3).
SCHEDULABLE_DIMENSIONS = ("grammar", "vocabulary", "coherence")

# §23.3: 1 → 2 → 4 → 8 …, and never further apart than a month.
MIN_INTERVAL_DAYS = 1
MAX_INTERVAL_DAYS = 30

_OVERDUE_WEIGHT = 0.4
_SKILL_GAP_WEIGHT = 0.4
_VOLATILITY_WEIGHT = 0.2

# Scores are bounded 0–1, so their stdev tops out at 0.5 (ADR 0008 §2.2).
_VOLATILITY_SCALE = 2.0
_VOLATILITY_WINDOW = 5


@dataclass(frozen=True)
class DimensionState:
    """One skill's SRS state, as stored on `skill_vectors`."""

    dimension: str
    score: float
    last_practiced_at: datetime | None
    interval_days: int


@dataclass(frozen=True)
class DimensionPriority:
    dimension: str
    priority: float
    overdue_ratio: float
    skill_gap: float
    volatility: float
    days_since_practice: float | None
    interval_days: int


def days_since(last_practiced_at: datetime | None, *, now: datetime) -> float | None:
    if last_practiced_at is None:
        return None
    return max((now - last_practiced_at).total_seconds() / 86_400, 0.0)


def overdue_ratio(elapsed_days: float | None, interval_days: int) -> float:
    """How due this skill is, on its own schedule (ADR 0008 §2.1).

    Never practised reads as fully overdue; the raw day count of §23.3 is
    unbounded and would drown the other two terms.
    """
    if elapsed_days is None:
        return 1.0
    interval = max(interval_days, MIN_INTERVAL_DAYS)
    return min(elapsed_days / interval, 1.0)


def volatility_factor(recent_scores: list[float]) -> float:
    """Instability of a dimension's recent scores (ADR 0008 §2.2)."""
    if len(recent_scores) < 2:
        return 0.0
    window = recent_scores[-_VOLATILITY_WINDOW:]
    return min(statistics.pstdev(window) * _VOLATILITY_SCALE, 1.0)


def compute_priority(
    state: DimensionState,
    *,
    recent_scores: list[float] | None = None,
    now: datetime | None = None,
) -> DimensionPriority:
    """Priority for one dimension — higher means practise it sooner."""
    now = now or datetime.now(UTC)
    elapsed = days_since(state.last_practiced_at, now=now)
    overdue = overdue_ratio(elapsed, state.interval_days)
    skill_gap = 1.0 - state.score
    volatility = volatility_factor(recent_scores or [])
    priority = (
        overdue * _OVERDUE_WEIGHT + skill_gap * _SKILL_GAP_WEIGHT + volatility * _VOLATILITY_WEIGHT
    )
    return DimensionPriority(
        dimension=state.dimension,
        priority=round(priority, 3),
        overdue_ratio=round(overdue, 3),
        skill_gap=round(skill_gap, 3),
        volatility=round(volatility, 3),
        days_since_practice=None if elapsed is None else round(elapsed, 2),
        interval_days=state.interval_days,
    )


def rank_dimensions(
    states: list[DimensionState],
    *,
    recent_scores: dict[str, list[float]] | None = None,
    now: datetime | None = None,
) -> list[DimensionPriority]:
    """Every schedulable dimension, most urgent first."""
    now = now or datetime.now(UTC)
    history = recent_scores or {}
    ranked = [
        compute_priority(state, recent_scores=history.get(state.dimension), now=now)
        for state in states
        if state.dimension in SCHEDULABLE_DIMENSIONS
    ]
    # Dimension name breaks ties so a given state always yields one schedule.
    return sorted(ranked, key=lambda p: (-p.priority, p.dimension))


def next_interval(current_interval_days: int, *, passed: bool) -> int:
    """§23.3: double on success up to the cap, reset to 1 day on failure."""
    if not passed:
        return MIN_INTERVAL_DAYS
    doubled = max(current_interval_days, MIN_INTERVAL_DAYS) * 2
    return min(doubled, MAX_INTERVAL_DAYS)
