"""Calibration domain (Phase 0 Brief §7): calibration_baselines.

Immutable once written — rows are only ever inserted (a recalibration adds a
new calibration_version), never updated. The active row per exam type is what
score reports display ("Score calibrated against N essays…", PRD §21.3).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models.base import Base


class CalibrationBaseline(Base):
    __tablename__ = "calibration_baselines"
    __table_args__ = (UniqueConstraint("calibration_version", "exam_type"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    calibration_version: Mapped[str] = mapped_column(String(50))  # e.g. v1.0-launch
    exam_type: Mapped[str] = mapped_column(String(50))
    sample_count: Mapped[int] = mapped_column(Integer)
    overall_pearson: Mapped[float] = mapped_column(Numeric(5, 4))
    category_pearson: Mapped[dict] = mapped_column(JSONB)
    human_examiner_count: Mapped[int] = mapped_column(Integer)
    inter_rater_kappa: Mapped[float | None] = mapped_column(Numeric(5, 4))
    calibration_date: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    signed_off_by: Mapped[str | None] = mapped_column(String(255))
    displayed_on_reports: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
