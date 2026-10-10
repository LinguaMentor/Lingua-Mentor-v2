"""Error reports to Bugsink, without local variables: a task's frames hold the essay it is scoring.

`python -m app.monitoring` sends one test error with this service's settings."""

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import sentry_sdk
from sentry_sdk.transport import Transport

from app.clients.ai_service import RetryableEvalError
from app.log_config import SERVICE_NAME, request_id_var
from app.settings import Settings, load_settings

logger = logging.getLogger(__name__)

Processor = Callable[[Any, str], Awaitable[Any]]


def _without_query(url: str) -> str:
    return url.split("?", 1)[0].split("#", 1)[0]


def scrub_event(event: Any, _hint: Any) -> Any:
    """Keeps the error and the path; drops request data, user fields, extras and frame variables."""
    request = event.get("request")
    if request is not None:
        url = request.get("url")
        event["request"] = {"url": _without_query(url)} if url else {}
    event.pop("user", None)
    event.pop("extra", None)
    for exception in (event.get("exception") or {}).get("values", []):
        for frame in (exception.get("stacktrace") or {}).get("frames", []):
            frame.pop("vars", None)
    for crumb in (event.get("breadcrumbs") or {}).get("values", []):
        data = crumb.get("data") or {}
        data.pop("http.query", None)
        data.pop("http.fragment", None)
        if isinstance(data.get("url"), str):
            data["url"] = _without_query(data["url"])
    return event


def init_monitoring(settings: Settings, transport: Transport | None = None) -> None:
    """Starts error reporting when SENTRY_DSN is set; without it, nothing is sent."""
    if not settings.sentry_dsn:
        return
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        release=settings.sentry_release or None,
        server_name=SERVICE_NAME,
        send_default_pii=False,
        include_local_variables=False,
        before_send=scrub_event,
        transport=transport,
    )
    # The services share one Bugsink project, so this is how their errors are told apart.
    sentry_sdk.get_global_scope().set_tag("service", SERVICE_NAME)


def with_job_context(processor: Processor) -> Processor:
    """Runs a job under the id of the request that queued it (a new one for scheduled jobs), and
    logs what bullmq would otherwise record silently as a failed job. Error logs are reported."""

    async def process(job: Any, token: str) -> Any:
        request_id = (job.data or {}).get("request_id") or str(uuid.uuid4())
        context = request_id_var.set(request_id)
        try:
            with sentry_sdk.isolation_scope() as scope:
                scope.set_tag("requestId", request_id)
                try:
                    return await processor(job, token)
                except RetryableEvalError:
                    # Expected while ai-service is down; the task logs the last attempt as an error.
                    raise
                except Exception:
                    logger.exception("job failed")
                    raise
        finally:
            request_id_var.reset(context)

    return process


if __name__ == "__main__":
    init_monitoring(load_settings())
    try:
        raise RuntimeError(f"Test error from {SERVICE_NAME}")
    except RuntimeError as error:
        print(sentry_sdk.capture_exception(error) or "SENTRY_DSN is not set, nothing was sent")
    sentry_sdk.flush()
