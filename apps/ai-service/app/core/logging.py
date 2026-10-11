"""JSON log lines in the gateway's shape (time, level, service, requestId, msg), with the request id
of whatever is being handled. Essays and chat text never go in a log message."""

import json
import logging
import re
import uuid
from contextvars import ContextVar
from datetime import UTC, datetime

SERVICE_NAME = "ai-service"
REQUEST_ID_HEADER = "x-request-id"

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

# Same rule as the gateway: a UUID or a trace id, nothing that could break a log line or a header.
_VALID_REQUEST_ID = re.compile(r"^[\w.:-]{1,128}$", re.ASCII)

# pino's level names, so one query works across the services.
_LEVELS = {"WARNING": "warn", "CRITICAL": "fatal"}

# Everything a LogRecord carries by default; any other attribute came from `extra=` and is logged.
_RECORD_FIELDS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime", "color_message"}


def request_id_or_new(incoming: str | None) -> str:
    return incoming if incoming and _VALID_REQUEST_ID.match(incoming) else str(uuid.uuid4())


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
    # Uvicorn sets up its own text handlers before importing the app; send its lines through ours.
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
    # The request middleware logs each request with its id; uvicorn's access line would repeat it.
    logging.getLogger("uvicorn.access").disabled = True
