"""Identity domain (Master PRD §28.3, ERD §29): users, learner_profiles.

All PII lives on `users` only — downstream entities reference learner_profile
ids and never duplicate name/email (PRD §28.2).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models.base import Base
from app.db.models.enums import (
    LearningTrack,
    SubscriptionTier,
    TeachingPersona,
    UserRole,
    pg_enum,
)


class User(Base):
    __tablename__ = "users"

    # Case-insensitive uniqueness holds even for writes that skip the Zod boundary.
    __table_args__ = (Index("uq_users_email_lower", text("lower(email)"), unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    email: Mapped[str] = mapped_column(String(255), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(100))
    role: Mapped[UserRole] = mapped_column(
        pg_enum(UserRole, "user_role"), server_default=UserRole.LEARNER.value
    )
    subscription_tier: Mapped[SubscriptionTier] = mapped_column(
        pg_enum(SubscriptionTier, "subscription_tier"),
        server_default=SubscriptionTier.FREE.value,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # "Last opened the app", which last_login_at can't answer: the silent refresh
    # never logs in, and refresh tokens rotate forever (ADR 0009 §2.3).
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # GDPR (PRD §10.5): erasure is a state transition, not a row delete —
    # anonymised aggregates must survive.
    gdpr_erasure_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retraining_opt_out: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class LearnerProfile(Base):
    __tablename__ = "learner_profiles"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    target_language: Mapped[str] = mapped_column(String(10))
    target_exam: Mapped[str | None] = mapped_column(String(50))
    target_band_score: Mapped[float | None] = mapped_column(Numeric(3, 1))
    exam_date: Mapped[date | None] = mapped_column(Date)
    # Accent is a first-class system parameter (PRD §7.2), not a cosmetic setting.
    accent_target: Mapped[str] = mapped_column(String(10), server_default="en-US")
    default_persona: Mapped[TeachingPersona] = mapped_column(
        pg_enum(TeachingPersona, "teaching_persona"),
        server_default=TeachingPersona.COMPANION.value,
    )
    active_track: Mapped[LearningTrack] = mapped_column(
        pg_enum(LearningTrack, "learning_track"),
        server_default=LearningTrack.FLUENCY.value,
    )
    # 4D CEFR profile (PRD §22). Listening/Reading are formula proxies in
    # Phase 1, populated with real data in Phases 2–3.
    cefr_speaking: Mapped[str | None] = mapped_column(String(2))
    cefr_listening: Mapped[str | None] = mapped_column(String(2))
    cefr_reading: Mapped[str | None] = mapped_column(String(2))
    cefr_writing: Mapped[str | None] = mapped_column(String(2))
    placement_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    voice_consent_given: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    weakness_tags: Mapped[dict | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
