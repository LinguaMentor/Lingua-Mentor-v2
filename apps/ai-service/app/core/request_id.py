"""Gives each request an id (the caller's when valid) for logs and error reports, and logs it."""

import logging
import time

import sentry_sdk
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import REQUEST_ID_HEADER, request_id_or_new, request_id_var

logger = logging.getLogger("app.request")

# Probed every few seconds by Docker; a line each time would bury the real traffic.
_UNLOGGED_PATHS = {"/health"}


class RequestIdMiddleware:
    # Plain ASGI, not BaseHTTPMiddleware, which breaks streamed responses like the mentor chat.
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope["headers"])
        incoming = headers.get(REQUEST_ID_HEADER.encode(), b"").decode("latin-1")
        request_id = request_id_or_new(incoming)
        token = request_id_var.set(request_id)
        # On the request's own Sentry scope: an unhandled error is reported after this has returned.
        sentry_sdk.set_tag("requestId", request_id)
        started = time.perf_counter()
        status = 500

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = [
                    *message.get("headers", []),
                    (REQUEST_ID_HEADER.encode(), request_id.encode()),
                ]
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            if scope["path"] not in _UNLOGGED_PATHS:
                logger.info(
                    "request completed",
                    extra={
                        "method": scope["method"],
                        "path": scope["path"],
                        "statusCode": status,
                        "durationMs": round((time.perf_counter() - started) * 1000),
                    },
                )
            request_id_var.reset(token)
