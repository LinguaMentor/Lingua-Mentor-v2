"""Queue registry — maps BullMQ queue names to processor factories.

Queue names MUST match apps/api-gateway/src/config/constants.ts 1:1 (the
producer and this registry are the two ends of the same wire), and each name
matches its module in app/tasks/ for easy tracing (see README).
"""

import asyncpg
import httpx
from bullmq import Queue

from app.monitoring import Processor, with_job_context
from app.tasks import (
    appeal_eval_task,
    daily_session_generation_task,
    srs_batch_generation_task,
    writing_eval_task,
)

QUEUE_WRITING_EVAL = "writing_eval"
QUEUE_APPEAL_EVAL = "appeal_eval"
QUEUE_SRS_BATCH_GENERATION = "srs_batch_generation"
QUEUE_DAILY_SESSION_GENERATION = "daily_session_generation"


def build_queue_registry(
    pool: asyncpg.Pool,
    http: httpx.AsyncClient,
    fanout_queue: Queue,
    active_within_days: int,
) -> dict[str, Processor]:
    registry = {
        QUEUE_WRITING_EVAL: writing_eval_task.make_processor(pool, http),
        QUEUE_APPEAL_EVAL: appeal_eval_task.make_processor(pool, http),
        # The 2AM job the gateway schedules; it enqueues onto the queue below.
        QUEUE_SRS_BATCH_GENERATION: srs_batch_generation_task.make_processor(
            pool, fanout_queue, active_within_days
        ),
        QUEUE_DAILY_SESSION_GENERATION: daily_session_generation_task.make_processor(pool, http),
        # Later slices: calibration_recompute
    }
    return {name: with_job_context(processor) for name, processor in registry.items()}
