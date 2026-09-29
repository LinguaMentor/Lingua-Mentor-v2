"""asyncpg queries for the writing-eval job lifecycle.

Deliberately duplicated from
apps/ai-service/app/db/repositories/writing_repository.py rather than shared:
per conventions doc §1 there is no packages/shared-py until a *second* Python
consumer of these queries exists — that's the extraction trigger.

One deliberate difference from ai-service's mark_processing (pending-only):
claim_session below also accepts 'processing', because BullMQ retries and
stalled-job redelivery re-enter with the row already 'processing' — a
pending-only guard would skip the retry and strand the session forever.

Band scores are NUMERIC(4,2) — pass Decimal, never float (PRD §28.2).
"""

import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

import asyncpg


async def claim_session(conn: asyncpg.Connection, session_id: UUID) -> asyncpg.Record | None:
    """Claim a session for evaluation. None → already scored/failed (a
    double-delivery after completion): the caller should skip, not error."""
    return await conn.fetchrow(
        """
        UPDATE writing_sessions SET status = 'processing'
        WHERE id = $1 AND status IN ('pending', 'processing')
        RETURNING id, exam_type, prompt_text, essay_text, calibration_version
        """,
        session_id,
    )


async def reset_to_pending(conn: asyncpg.Connection, session_id: UUID) -> None:
    """Put the session back to pending before a retryable failure is re-raised,
    so the poll endpoint never shows 'processing' for a job sitting in backoff."""
    await conn.execute("UPDATE writing_sessions SET status = 'pending' WHERE id = $1", session_id)


async def mark_failed(conn: asyncpg.Connection, session_id: UUID) -> None:
    await conn.execute("UPDATE writing_sessions SET status = 'failed' WHERE id = $1", session_id)


async def save_score(
    conn: asyncpg.Connection,
    *,
    session_id: UUID,
    overall_band_score: Decimal,
    cefr_level: str | None,
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
