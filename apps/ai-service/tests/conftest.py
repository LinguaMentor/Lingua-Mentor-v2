"""Shared fixtures — integration tests run against a real Postgres.

Point DATABASE_URL at a throwaway database (local container or Neon branch)
with migrations applied (`alembic upgrade head`). Tests that need the DB are
skipped, not failed, when DATABASE_URL is unset — so the suite stays runnable
in environments without a database.
"""

import os
import uuid

import asyncpg
import pytest
import pytest_asyncio

DATABASE_URL = os.environ.get("DATABASE_URL", "")

requires_db = pytest.mark.skipif(
    not DATABASE_URL, reason="DATABASE_URL not set — DB integration tests skipped"
)


@pytest_asyncio.fixture
async def db_conn():
    """One rolled-back transaction per test — tests never leak rows."""
    conn = await asyncpg.connect(DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://", 1))
    tx = conn.transaction()
    await tx.start()
    try:
        yield conn
    finally:
        await tx.rollback()
        await conn.close()


@pytest_asyncio.fixture
async def learner_profile_id(db_conn) -> uuid.UUID:
    """A user + learner profile to hang test data off."""
    user_id = await db_conn.fetchval(
        """
        INSERT INTO users (email, password_hash, display_name)
        VALUES ($1, 'x', 'Test Learner') RETURNING id
        """,
        f"test-{uuid.uuid4()}@example.com",
    )
    return await db_conn.fetchval(
        """
        INSERT INTO learner_profiles (user_id, target_language, target_exam)
        VALUES ($1, 'en', 'ielts_academic') RETURNING id
        """,
        user_id,
    )
