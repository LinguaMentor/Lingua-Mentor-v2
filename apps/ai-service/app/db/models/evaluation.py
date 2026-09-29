"""Evaluation domain (Master PRD §28.3, ERD §29): writing_sessions,
writing_score_breakdowns, score_appeals, speaking_sessions.

Band scores are NUMERIC(4,2) — the project-wide rule (conventions doc §3);
rubric category weights are NUMERIC(4,3) fractions that must sum to 1.
Rubric categories are generic slots (category_1..4 name/score/weight/feedback)
so IELTS/TOEFL/DELF rubrics share one shape — the exam YAML defines the names.

Deviation from ERD §29: category_4_* is nullable. The ERD marks all four
slots NOT NULL, but TOEFL's official writing rubric has three categories
(PRD §5.2), and §8.1's exam-first principle — output structures mirror the
target exam's rubric — takes precedence over the ERD detail.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models.base import Base
from app.db.models.enums import (
    AppealStatus,
    SpeakingSessionType,
    TeachingPersona,
    WritingSessionStatus,
    pg_enum,
)


class WritingSession(Base):
    __tablename__ = "writing_sessions"
    __table_args__ = (Index("ix_writing_sessions_learner_status", "learner_profile_id", "status"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    learner_profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learner_profiles.id", ondelete="CASCADE")
    )
    exam_type: Mapped[str] = mapped_column(String(50))
    prompt_text: Mapped[str] = mapped_column(Text)
    essay_text: Mapped[str] = mapped_column(Text)
    status: Mapped[WritingSessionStatus] = mapped_column(
        pg_enum(WritingSessionStatus, "writing_session_status"),
        server_default=WritingSessionStatus.PENDING.value,
    )
    word_count: Mapped[int | None] = mapped_column(Integer)
    overall_band_score: Mapped[float | None] = mapped_column(Numeric(4, 2))
    cefr_level: Mapped[str | None] = mapped_column(String(2))
    # Calibration transparency (PRD §21.3): every scored session records the
    # calibration baseline it was scored under; the report displays it.
    calibration_version: Mapped[str | None] = mapped_column(String(50))
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    scored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class WritingScoreBreakdown(Base):
    __tablename__ = "writing_score_breakdowns"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    writing_session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("writing_sessions.id", ondelete="CASCADE"), unique=True
    )

    category_1_name: Mapped[str] = mapped_column(String(100))
    category_1_score: Mapped[float] = mapped_column(Numeric(4, 2))
    category_1_weight: Mapped[float] = mapped_column(Numeric(4, 3))
    category_1_feedback: Mapped[str | None] = mapped_column(Text)

    category_2_name: Mapped[str] = mapped_column(String(100))
    category_2_score: Mapped[float] = mapped_column(Numeric(4, 2))
    category_2_weight: Mapped[float] = mapped_column(Numeric(4, 3))
    category_2_feedback: Mapped[str | None] = mapped_column(Text)

    category_3_name: Mapped[str] = mapped_column(String(100))
    category_3_score: Mapped[float] = mapped_column(Numeric(4, 2))
    category_3_weight: Mapped[float] = mapped_column(Numeric(4, 3))
    category_3_feedback: Mapped[str | None] = mapped_column(Text)

    # Nullable: 3-category rubrics (TOEFL) leave the 4th slot empty.
    category_4_name: Mapped[str | None] = mapped_column(String(100))
    category_4_score: Mapped[float | None] = mapped_column(Numeric(4, 2))
    category_4_weight: Mapped[float | None] = mapped_column(Numeric(4, 3))
    category_4_feedback: Mapped[str | None] = mapped_column(Text)

    grammar_corrections: Mapped[dict | None] = mapped_column(JSONB)
    vocabulary_suggestions: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class ScoreAppeal(Base):
    __tablename__ = "score_appeals"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    writing_session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("writing_sessions.id", ondelete="CASCADE")
    )
    learner_profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learner_profiles.id", ondelete="CASCADE")
    )
    appeal_reason: Mapped[str | None] = mapped_column(Text)
    status: Mapped[AppealStatus] = mapped_column(
        pg_enum(AppealStatus, "appeal_status"),
        server_default=AppealStatus.PENDING.value,
    )
    original_score: Mapped[float] = mapped_column(Numeric(4, 2))
    secondary_score: Mapped[float | None] = mapped_column(Numeric(4, 2))
    discrepancy_delta: Mapped[float | None] = mapped_column(Numeric(4, 2))
    secondary_model_config: Mapped[dict | None] = mapped_column(JSONB)
    # PRD §21.4: discrepancy > 0.5 band flags the appeal for human review.
    requires_human_review: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class SpeakingSession(Base):
    __tablename__ = "speaking_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    learner_profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learner_profiles.id", ondelete="CASCADE")
    )
    session_type: Mapped[SpeakingSessionType] = mapped_column(
        pg_enum(SpeakingSessionType, "speaking_session_type")
    )
    persona_used: Mapped[TeachingPersona] = mapped_column(
        pg_enum(TeachingPersona, "teaching_persona"),
        server_default=TeachingPersona.COMPANION.value,
    )
    exam_type: Mapped[str | None] = mapped_column(String(50))
    accent_target: Mapped[str] = mapped_column(String(10))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    socratic_turns_used: Mapped[int | None] = mapped_column(Integer)
    transcript_text: Mapped[str | None] = mapped_column(Text)
    overall_fluency_score: Mapped[float | None] = mapped_column(Numeric(4, 2))
    overall_pronunciation_score: Mapped[float | None] = mapped_column(Numeric(4, 2))
    cefr_speaking_level: Mapped[str | None] = mapped_column(String(2))
    # R2 object key only — audio bytes never touch Postgres (PRD §28.1).
    audio_blob_key: Mapped[str | None] = mapped_column(String(500))
    ai_model_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ai_model_runs.id", ondelete="RESTRICT")
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
