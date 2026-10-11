"""Error reports to Bugsink, without request bodies or local variables: both hold essays.

`python -m app.core.monitoring` sends one test error with this service's settings."""

from typing import Any

import sentry_sdk
from sentry_sdk.transport import Transport

from app.core.config import Settings, get_settings
from app.core.logging import SERVICE_NAME


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
        max_request_body_size="never",
        before_send=scrub_event,
        transport=transport,
    )
    # The services share one Bugsink project, so this is how their errors are told apart.
    sentry_sdk.get_global_scope().set_tag("service", SERVICE_NAME)


if __name__ == "__main__":
    init_monitoring(get_settings())
    try:
        raise RuntimeError(f"Test error from {SERVICE_NAME}")
    except RuntimeError as error:
        print(sentry_sdk.capture_exception(error) or "SENTRY_DSN is not set, nothing was sent")
    sentry_sdk.flush()
