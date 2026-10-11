"""BullMQ processor: srs_batch_generation.

Fires at 2AM UTC from the Job Scheduler the gateway upserts (ADR 0009 §2.7).
Fans out rather than generating inline: a thousand learners at ~3s each is an
hour inside one job, where a single learner's failure retries all of them.

Carries no payload — the active-learner set is read here, at run time.
"""

import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import asyncpg
from bullmq import Queue

from app.db.daily_session_queries import list_active_learners
from app.log_config import request_id_var

logger = logging.getLogger(__name__)

JOB_DAILY_SESSION_GENERATE = "generate"


async def run_srs_batch(
    *, pool: asyncpg.Pool, queue: Queue, active_within_days: int
) -> dict[str, int]:
    """Enqueue one generation job per active learner."""
    async with pool.acquire() as conn:
        learners = await list_active_learners(conn, active_within_days=active_within_days)

    session_date = datetime.now(UTC).date().isoformat()
    for learner in learners:
        learner_profile_id = str(learner["learner_profile_id"])
        # jobId per learner-day: a scheduler misfire or a manual re-run can't
        # bill the same learner twice.
        await queue.add(
            JOB_DAILY_SESSION_GENERATE,
            # The batch's id, so one night's generation can be followed through every learner's job.
            {"learner_profile_id": learner_profile_id, "request_id": request_id_var.get()},
            {"jobId": f"{learner_profile_id}:{session_date}"},
        )

    logger.info("srs_batch_generation fanned out to %d learners", len(learners))
    return {"enqueued": len(learners)}


def make_processor(
    pool: asyncpg.Pool, queue: Queue, active_within_days: int
) -> Callable[[Any, str], Awaitable[Any]]:
    async def process(job: Any, job_token: str) -> Any:
        return await run_srs_batch(pool=pool, queue=queue, active_within_days=active_within_days)

    return process
