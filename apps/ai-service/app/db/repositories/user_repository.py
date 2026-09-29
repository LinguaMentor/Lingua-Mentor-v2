"""asyncpg queries for users/learner_profiles — runtime data-access path.

*Identity* writes (register, login bookkeeping) belong to api-gateway's auth
module; this service only reads that state. The exception is AI-derived profile
state — the 4D CEFR profile is produced by evaluation here (PRD §22), so its
write lives with the engine that computes it, not with auth.
"""

from uuid import UUID

import asyncpg


async def get_subscription_tier(conn: asyncpg.Connection, learner_profile_id: UUID) -> str | None:
    """The tier that gates persona choice (§17.4). Read fresh rather than taken
    from the caller: the JWT's `tier` claim is up to 15 minutes stale.
    """
    return await conn.fetchval(
        """
        SELECT u.subscription_tier
        FROM users u
        JOIN learner_profiles lp ON lp.user_id = u.id
        WHERE lp.id = $1
        """,
        learner_profile_id,
    )


async def get_learner_profile(
    conn: asyncpg.Connection, learner_profile_id: UUID
) -> asyncpg.Record | None:
    return await conn.fetchrow(
        """
        SELECT id, user_id, target_language, target_exam, target_band_score,
               exam_date, accent_target, default_persona, active_track,
               cefr_speaking, cefr_listening, cefr_reading, cefr_writing,
               placement_completed_at, voice_consent_given,
               onboarding_completed, weakness_tags
        FROM learner_profiles
        WHERE id = $1
        """,
        learner_profile_id,
    )


async def get_learner_profile_by_user(
    conn: asyncpg.Connection, user_id: UUID
) -> asyncpg.Record | None:
    return await conn.fetchrow("SELECT * FROM learner_profiles WHERE user_id = $1", user_id)


async def initialize_cefr_profile(
    conn: asyncpg.Connection,
    learner_profile_id: UUID,
    *,
    cefr_writing: str | None,
    cefr_reading: str | None,
) -> bool:
    """Write the placement-derived dimensions and mark onboarding complete
    (PRD §22.3). Speaking/listening are left untouched — they stay NULL until
    the Voice pipeline populates them (Phase 2). Returns False if the profile
    id doesn't exist."""
    status = await conn.fetchval(
        """
        UPDATE learner_profiles
        SET cefr_writing = $2,
            cefr_reading = $3,
            placement_completed_at = now(),
            onboarding_completed = true,
            updated_at = now()
        WHERE id = $1
        RETURNING id
        """,
        learner_profile_id,
        cefr_writing,
        cefr_reading,
    )
    return status is not None
