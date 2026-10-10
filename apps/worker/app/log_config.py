"""JSON log lines in the gateway's shape (time, level, service, requestId, msg), with the id of the
request that queued the job. Kept in step with ai-service's app/core/logging.py."""

import json
import logging
from contextvars import ContextVar
from datetime import UTC, datetime

SERVICE_NAME = "worker"
REQUEST_ID_HEADER = "x-request-id"

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

# pino's level names, so one query works across the services.
_LEVELS = {"WARNING": "warn", "CRITICAL": "fatal"}

# Everything a LogRecord carries by default; any other attribute came from `extra=` and is logged.
_RECORD_FIELDS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": _LEVELS.get(record.levelname, record.levelname.lower()),
            "service": SERVICE_NAME,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id:
            entry["requestId"] = request_id
        entry.update((k, v) for k, v in record.__dict__.items() if k not in _RECORD_FIELDS)
        if record.exc_info and record.exc_info[1] is not None:
            error = record.exc_info[1]
            entry["err"] = {
                "type": type(error).__name__,
                "message": str(error),
                "stack": self.formatException(record.exc_info),
            }
        return json.dumps(entry, default=str)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
