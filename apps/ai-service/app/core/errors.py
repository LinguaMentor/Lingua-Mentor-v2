"""Global error envelope — every error this service returns has the shape
{"error": {"code", "message", "field"?}} (Master PRD §34.1), so clients
never branch on two error formats.
"""

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.engines.writing_evaluation import (
    EvaluationError,
    PlacementUnavailableError,
    UnknownExamError,
)


def envelope(code: str, message: str, field: str | None = None) -> dict:
    error: dict = {"code": code, "message": message}
    if field is not None:
        error["field"] = field
    return {"error": error}


_STATUS_CODES = {
    status.HTTP_400_BAD_REQUEST: "BAD_REQUEST",
    status.HTTP_401_UNAUTHORIZED: "UNAUTHORIZED",
    status.HTTP_403_FORBIDDEN: "FORBIDDEN",
    status.HTTP_404_NOT_FOUND: "NOT_FOUND",
    status.HTTP_429_TOO_MANY_REQUESTS: "RATE_LIMITED",
}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        code = _STATUS_CODES.get(exc.status_code, "ERROR")
        return JSONResponse(status_code=exc.status_code, content=envelope(code, str(exc.detail)))

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(loc) for loc in first.get("loc", []) if loc != "body")
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=envelope(
                "VALIDATION_ERROR", first.get("msg", "invalid request"), field or None
            ),
        )

    @app.exception_handler(UnknownExamError)
    async def unknown_exam_handler(request: Request, exc: UnknownExamError):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=envelope("UNKNOWN_EXAM", str(exc), "exam_type"),
        )

    @app.exception_handler(PlacementUnavailableError)
    async def placement_unavailable_handler(request: Request, exc: PlacementUnavailableError):
        # A known exam that simply can't seat a placement yet — the client has to
        # tell the learner that plainly, so it needs a code it can branch on.
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=envelope("PLACEMENT_NOT_AVAILABLE", str(exc), "exam_type"),
        )

    @app.exception_handler(EvaluationError)
    async def evaluation_error_handler(request: Request, exc: EvaluationError):
        # Upstream model couldn't produce a valid evaluation — the caller may
        # retry; the submission itself is fine (PRD §10.3 partial-failure UX).
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content=envelope("EVALUATION_FAILED", str(exc)),
        )

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception):
        # Never leak internals in the message — details go to logs/Sentry.
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=envelope("INTERNAL_ERROR", "internal server error"),
        )
