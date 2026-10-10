"""Worker entry point — starts one BullMQ Worker per queue in the registry."""

import asyncio
import logging
import signal

import asyncpg
from bullmq import Queue, Worker

from app.clients.ai_service import make_client
from app.log_config import configure_logging
from app.monitoring import init_monitoring
from app.settings import load_settings
from app.worker_settings import QUEUE_DAILY_SESSION_GENERATION, build_queue_registry

logger = logging.getLogger(__name__)


async def run() -> None:
    settings = load_settings()
    init_monitoring(settings)
    pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)
    http = make_client(settings.ai_service_url)

    # The 2AM batch fans out onto this queue, which this same worker consumes.
    fanout_queue = Queue(QUEUE_DAILY_SESSION_GENERATION, {"connection": settings.redis_url})

    workers = [
        Worker(
            name,
            processor,
            {"connection": settings.redis_url, "concurrency": settings.concurrency},
        )
        for name, processor in build_queue_registry(
            pool, http, fanout_queue, settings.pregeneration_active_window_days
        ).items()
    ]
    logger.info("worker started — queues: %s", ", ".join(w.name for w in workers))

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()

    logger.info("shutting down — finishing in-flight jobs")
    for worker in workers:
        await worker.close()
    await fanout_queue.close()
    await http.aclose()
    await pool.close()


if __name__ == "__main__":
    configure_logging()
    asyncio.run(run())
