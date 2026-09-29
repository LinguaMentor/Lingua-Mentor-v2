"""asyncpg queries for calibration_baselines (Phase 0 Brief §7).

Insert-only by design — recalibration inserts a new version; nothing here
updates or deletes existing baselines.
"""

from datetime import datetime
from decimal import Decimal

import asyncpg


async def get_active_baseline(conn: asyncpg.Connection, exam_type: str) -> asyncpg.Record | None:
    """Latest displayable baseline for an exam type — what score reports cite."""
    return await conn.fetchrow(
        """
        SELECT calibration_version, exam_type, sample_count, overall_pearson,
               category_pearson, calibration_date
        FROM calibration_baselines
        WHERE exam_type = $1 AND displayed_on_reports = true
        ORDER BY calibration_date DESC
        LIMIT 1
        """,
        exam_type,
    )


async def insert_baseline(
    conn: asyncpg.Connection,
    *,
    calibration_version: str,
    exam_type: str,
    sample_count: int,
    overall_pearson: float,
    category_pearson: str,  # JSON string
    human_examiner_count: int,
    inter_rater_kappa: float | None,
    calibration_date: datetime,
    signed_off_by: str | None,
) -> None:
    # asyncpg rejects float for NUMERIC params; route via str() so the value
    # lands exactly, no binary-float artifact (same no-drift rule as scores).
    await conn.execute(
        """
        INSERT INTO calibration_baselines (
            calibration_version, exam_type, sample_count, overall_pearson,
            category_pearson, human_examiner_count, inter_rater_kappa,
            calibration_date, signed_off_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        """,
        calibration_version,
        exam_type,
        sample_count,
        Decimal(str(overall_pearson)),
        category_pearson,
        human_examiner_count,
        None if inter_rater_kappa is None else Decimal(str(inter_rater_kappa)),
        calibration_date,
        signed_off_by,
    )
