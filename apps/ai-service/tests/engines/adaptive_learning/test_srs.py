"""Skill-level SRS tests (PRD §23.3 as amended by ADR 0008)."""

from datetime import UTC, datetime, timedelta

import pytest

from app.engines.adaptive_learning import (
    MAX_INTERVAL_DAYS,
    SCHEDULABLE_DIMENSIONS,
    DimensionState,
    compute_priority,
    next_interval,
    rank_dimensions,
    volatility_factor,
)

NOW = datetime(2026, 7, 17, 12, 0, tzinfo=UTC)


def state(dimension="grammar", *, score=0.5, days_ago=None, interval=1):
    last = None if days_ago is None else NOW - timedelta(days=days_ago)
    return DimensionState(
        dimension=dimension, score=score, last_practiced_at=last, interval_days=interval
    )


class TestPriorityBounds:
    def test_priority_never_exceeds_one(self):
        # The whole point of ADR 0008 §2.1: the literal §23.3 formula grows
        # without bound and overflows daily_sessions.srs_priority_score.
        worst = compute_priority(state(score=0.0, days_ago=3650, interval=1), now=NOW)

        assert worst.priority <= 1.0

    def test_a_year_overdue_does_not_overflow_numeric_5_3(self):
        p = compute_priority(state(score=0.0, days_ago=365, interval=30), now=NOW)

        assert p.priority < 100  # NUMERIC(5,3) caps at 99.999

    def test_skill_score_still_moves_the_ranking_when_both_are_overdue(self):
        # Under the literal formula the day count swamps the score term; here a
        # weaker skill must win between two equally overdue dimensions.
        weak = compute_priority(state("grammar", score=0.2, days_ago=10, interval=1), now=NOW)
        strong = compute_priority(state("vocabulary", score=0.9, days_ago=10, interval=1), now=NOW)

        assert weak.priority > strong.priority


class TestOverdueRatio:
    def test_never_practised_reads_as_fully_overdue(self):
        p = compute_priority(state(days_ago=None), now=NOW)

        assert p.overdue_ratio == 1.0
        assert p.days_since_practice is None

    def test_due_exactly_on_schedule_is_fully_overdue(self):
        p = compute_priority(state(days_ago=4, interval=4), now=NOW)

        assert p.overdue_ratio == 1.0

    def test_halfway_through_the_interval_is_half_overdue(self):
        p = compute_priority(state(days_ago=2, interval=4), now=NOW)

        assert p.overdue_ratio == 0.5

    def test_overdue_is_relative_to_each_dimension_own_interval(self):
        # Same elapsed time, different schedules: the one due more often is
        # more overdue. Normalising against a constant would lose this.
        frequent = compute_priority(state("grammar", days_ago=8, interval=2), now=NOW)
        rare = compute_priority(state("vocabulary", days_ago=8, interval=30), now=NOW)

        assert frequent.overdue_ratio > rare.overdue_ratio


class TestVolatility:
    def test_insufficient_history_contributes_nothing(self):
        assert volatility_factor([]) == 0.0
        assert volatility_factor([0.6]) == 0.0

    def test_a_steady_skill_has_no_volatility(self):
        assert volatility_factor([0.6, 0.6, 0.6]) == 0.0

    def test_a_swinging_skill_scores_higher_than_a_steady_one(self):
        assert volatility_factor([0.1, 0.9, 0.2, 0.8]) > volatility_factor([0.5, 0.55, 0.5])

    def test_volatility_stays_within_zero_to_one(self):
        assert volatility_factor([0.0, 1.0, 0.0, 1.0]) <= 1.0

    def test_only_the_last_five_observations_count(self):
        # A long-settled skill shouldn't stay urgent because of ancient swings.
        ancient_swings = [0.0, 1.0, 0.0, 1.0] + [0.5] * 5

        assert volatility_factor(ancient_swings) == 0.0


class TestIntervalLadder:
    @pytest.mark.parametrize(
        ("current", "expected"), [(1, 2), (2, 4), (4, 8), (8, 16), (16, 30), (30, 30)]
    )
    def test_success_doubles_up_to_the_cap(self, current, expected):
        assert next_interval(current, passed=True) == expected

    def test_failure_resets_to_one_day(self):
        assert next_interval(MAX_INTERVAL_DAYS, passed=False) == 1


class TestRanking:
    def test_unpractisable_dimensions_are_never_scheduled(self):
        # pronunciation/fluency need the Voice Agent (Phase 2) and would
        # otherwise top every schedule as never-practised (ADR 0008 §2.3).
        states = [
            state("grammar", score=0.9, days_ago=0, interval=30),
            state("pronunciation", score=0.1, days_ago=None),
            state("fluency", score=0.1, days_ago=None),
            state("comprehension", score=0.1, days_ago=None),
        ]

        ranked = rank_dimensions(states, now=NOW)

        assert [p.dimension for p in ranked] == ["grammar"]

    def test_returns_every_schedulable_dimension_most_urgent_first(self):
        states = [
            state("grammar", score=0.9, days_ago=0, interval=10),
            state("vocabulary", score=0.2, days_ago=None),
            state("coherence", score=0.5, days_ago=5, interval=10),
        ]

        ranked = rank_dimensions(states, now=NOW)

        assert [p.dimension for p in ranked] == ["vocabulary", "coherence", "grammar"]
        assert len(ranked) == len(SCHEDULABLE_DIMENSIONS)

    def test_ties_break_deterministically(self):
        states = [
            state("vocabulary", score=0.5, days_ago=1),
            state("grammar", score=0.5, days_ago=1),
        ]

        assert [p.dimension for p in rank_dimensions(states, now=NOW)] == ["grammar", "vocabulary"]

    def test_volatility_history_reaches_the_score(self):
        states = [
            state("grammar", score=0.5, days_ago=1, interval=1),
            state("vocabulary", score=0.5, days_ago=1, interval=1),
        ]

        ranked = rank_dimensions(states, recent_scores={"grammar": [0.1, 0.9, 0.1, 0.9]}, now=NOW)

        assert ranked[0].dimension == "grammar"
        assert ranked[0].volatility > 0
