"""Shared fixtures — mirrors apps/ai-service/tests/conftest.py conventions.

DB integration tests need DATABASE_URL pointing at a Postgres with the
ai-service migrations applied (cd apps/ai-service && alembic upgrade head);
they are skipped, not failed, when DATABASE_URL is unset.
"""

import os
import uuid

import asyncpg
import httpx
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


class FakePool:
    """Duck-types asyncpg.Pool.acquire() to hand out the test's rolled-back
    connection, so task code written against a pool runs inside the test
    transaction."""

    def __init__(self, conn: asyncpg.Connection):
        self._conn = conn

    def acquire(self):
        conn = self._conn

        class _Ctx:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *exc):
                return False

        return _Ctx()


@pytest_asyncio.fixture
async def fake_pool(db_conn) -> FakePool:
    return FakePool(db_conn)


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


@pytest_asyncio.fixture
async def writing_session_id(db_conn, learner_profile_id) -> uuid.UUID:
    """A pending writing session, as the gateway's submit endpoint creates it."""
    return await db_conn.fetchval(
        """
        INSERT INTO writing_sessions
            (learner_profile_id, exam_type, prompt_text, essay_text, word_count)
        VALUES ($1, 'ielts_academic', 'Discuss both views.', 'Essay text here.', 3)
        RETURNING id
        """,
        learner_profile_id,
    )


def mock_http(handler) -> httpx.AsyncClient:
    """An AsyncClient whose transport is the given handler(request) -> Response —
    stands in for ai-service the way FakeProvider stands in for the LLM."""
    return httpx.AsyncClient(
        base_url="http://ai-service.test", transport=httpx.MockTransport(handler)
    )
