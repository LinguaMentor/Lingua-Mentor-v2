"""asyncpg queries for writing_sessions + writing_score_breakdowns.

Band scores are NUMERIC(4,2) — pass Decimal, never float, to avoid rounding
drift in calibration comparisons (PRD §28.2).
"""

import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

import asyncpg


async def create_session(
    conn: asyncpg.Connection,
    *,
    learner_profile_id: UUID,
    exam_type: str,
    prompt_text: str,
    essay_text: str,
    word_count: int,
) -> UUID:
    return await conn.fetchval(
        """
        INSERT INTO writing_sessions
            (learner_profile_id, exam_type, prompt_text, essay_text, word_count)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        """,
        learner_profile_id,
        exam_type,
        prompt_text,
        essay_text,
        word_count,
    )


async def mark_processing(conn: asyncpg.Connection, session_id: UUID) -> bool:
    """Transition pending → processing. Returns False if the session was not
    pending (double-delivery guard for the queue consumer)."""
    status = await conn.fetchval(
        """
        UPDATE writing_sessions SET status = 'processing'
        WHERE id = $1 AND status = 'pending'
        RETURNING status
        """,
        session_id,
    )
    return status is not None


async def mark_failed(conn: asyncpg.Connection, session_id: UUID) -> None:
    await conn.execute("UPDATE writing_sessions SET status = 'failed' WHERE id = $1", session_id)


async def save_score(
    conn: asyncpg.Connection,
    *,
    session_id: UUID,
    overall_band_score: Decimal,
    cefr_level: str,
    calibration_version: str | None,
    categories: list[dict],  # 3–4 items: {name, score: Decimal, weight: Decimal, feedback}
    grammar_corrections: list | None,
    vocabulary_suggestions: list | None,
) -> None:
    """Persist a completed evaluation atomically: session row + breakdown row.

    3-category rubrics (TOEFL) leave the 4th breakdown slot NULL.
    """
    if len(categories) not in (3, 4):
        raise ValueError(f"expected 3 or 4 rubric categories, got {len(categories)}")
    padded = categories + [{"name": None, "score": None, "weight": None}] * (4 - len(categories))
    async with conn.transaction():
        await conn.execute(
            """
            UPDATE writing_sessions
            SET status = 'scored', overall_band_score = $2, cefr_level = $3,
                calibration_version = $4, scored_at = $5
            WHERE id = $1
            """,
            session_id,
            overall_band_score,
            cefr_level,
            calibration_version,
            datetime.now(UTC),
        )
        await conn.execute(
            """
            INSERT INTO writing_score_breakdowns (
                writing_session_id,
                category_1_name, category_1_score, category_1_weight, category_1_feedback,
                category_2_name, category_2_score, category_2_weight, category_2_feedback,
                category_3_name, category_3_score, category_3_weight, category_3_feedback,
                category_4_name, category_4_score, category_4_weight, category_4_feedback,
                grammar_corrections, vocabulary_suggestions
            )
            VALUES ($1, $2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12,$13, $14,$15,$16,$17, $18, $19)
            """,
            session_id,
            *[
                value
                for c in padded
                for value in (c["name"], c["score"], c["weight"], c.get("feedback"))
            ],
            json.dumps(grammar_corrections) if grammar_corrections is not None else None,
            json.dumps(vocabulary_suggestions) if vocabulary_suggestions is not None else None,
        )


async def get_session_with_breakdown(
    conn: asyncpg.Connection, session_id: UUID
) -> asyncpg.Record | None:
    return await conn.fetchrow(
        """
        SELECT ws.*,
               b.category_1_name, b.category_1_score, b.category_1_weight, b.category_1_feedback,
               b.category_2_name, b.category_2_score, b.category_2_weight, b.category_2_feedback,
               b.category_3_name, b.category_3_score, b.category_3_weight, b.category_3_feedback,
               b.category_4_name, b.category_4_score, b.category_4_weight, b.category_4_feedback,
               b.grammar_corrections, b.vocabulary_suggestions
        FROM writing_sessions ws
        LEFT JOIN writing_score_breakdowns b ON b.writing_session_id = ws.id
        WHERE ws.id = $1
        """,
        session_id,
    )
