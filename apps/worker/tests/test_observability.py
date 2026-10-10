"""Request ids, JSON logs and error reports around a job, with a stub connection and a mock ai-service."""

import io
import json
import logging
import uuid
from types import SimpleNamespace

import httpx
import pytest
import sentry_sdk
from sentry_sdk.transport import Transport

from app.clients.ai_service import RetryableEvalError, make_client
from app.log_config import JsonFormatter, request_id_var
from app.monitoring import init_monitoring, scrub_event, with_job_context
from app.settings import Settings
from app.tasks import srs_batch_generation_task, writing_eval_task

# A known essay: if it shows up in a log line or an error report, the test fails.
ESSAY = "ESSAY-MARKER-b8c2 Tourism brings money to a town but changes who can afford to live there."
MARKER = "ESSAY-MARKER-b8c2"
SESSION_ID = str(uuid.uuid4())


class StubConn:
    """Hands out one pending submission, the way claim_session's query would."""

    def __init__(self, fail_with: Exception | None = None):
        self.fail_with = fail_with

    async def fetchrow(self, *_args):
        if self.fail_with:
            raise self.fail_with
        return {
            "exam_type": "ielts_academic",
            "prompt_text": "Discuss.",
            "essay_text": ESSAY,
            "calibration_version": None,
        }

    async def execute(self, *_args):
        return None


class StubPool:
    def __init__(self, conn: StubConn):
        self.conn = conn

    def acquire(self):
        conn = self.conn

        class _Ctx:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *exc):
                return False

        return _Ctx()


def job(data: dict, attempts: int = 1):
    return SimpleNamespace(data=data, opts={"attempts": attempts}, attemptsMade=0)


def ai_service(status: int, seen: list[httpx.Request]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            status, json={"error": {"code": "EVALUATION_FAILED", "message": "model output failed"}}
        )

    return make_client("http://ai-service.test", transport=httpx.MockTransport(handler))


def writing_job(conn: StubConn, http: httpx.AsyncClient):
    return with_job_context(writing_eval_task.make_processor(StubPool(conn), http))  # type: ignore[arg-type]


@pytest.fixture
def json_logs():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    previous = root.level
    root.setLevel(logging.INFO)
    yield stream
    root.removeHandler(handler)
    root.setLevel(previous)


def entries(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


class RecordingTransport(Transport):
    def __init__(self, options=None):
        super().__init__(options)
        self.envelopes: list = []

    def capture_envelope(self, envelope):
        self.envelopes.append(envelope)


@pytest.fixture
def reports():
    transport = RecordingTransport()
    settings = Settings(
        redis_url="redis://unused",
        database_url="postgresql://unused",
        ai_service_url="http://unused",
        sentry_dsn="http://publickey@127.0.0.1:9/5",
        sentry_environment="test-environment",
        sentry_release="0123abc",
    )
    init_monitoring(settings, transport=transport)
    yield transport
    sentry_sdk.get_global_scope().set_client(None)


def events(transport: RecordingTransport) -> list[dict]:
    sentry_sdk.flush()
    return [envelope.get_event() for envelope in transport.envelopes if envelope.get_event()]


async def test_a_job_logs_and_calls_ai_service_under_the_queuing_request_id(json_logs):
    seen: list[httpx.Request] = []
    process = writing_job(StubConn(), ai_service(400, seen))

    result = await process(job({"session_id": SESSION_ID, "request_id": "req-w-1"}), "token")

    assert result == "failed"
    assert seen[0].headers["x-request-id"] == "req-w-1"
    logged = entries(json_logs)
    assert logged and all(e["requestId"] == "req-w-1" for e in logged)
    assert all(e["service"] == "worker" for e in logged)
    assert MARKER not in json_logs.getvalue()
    assert request_id_var.get() is None


async def test_a_scheduled_job_gets_its_own_request_id(json_logs):
    seen: list[httpx.Request] = []
    process = writing_job(StubConn(), ai_service(400, seen))

    await process(job({"session_id": SESSION_ID}), "token")

    generated = seen[0].headers["x-request-id"]
    assert len(generated) == 36
    assert {e["requestId"] for e in entries(json_logs)} == {generated}


async def test_a_failed_last_attempt_is_reported_without_the_essay(reports, json_logs):
    process = writing_job(StubConn(), ai_service(502, []))

    with pytest.raises(RetryableEvalError):
        await process(job({"session_id": SESSION_ID, "request_id": "req-w-2"}), "token")

    reported = events(reports)
    assert len(reported) == 1
    assert reported[0]["environment"] == "test-environment"
    assert reported[0]["release"] == "0123abc"
    assert reported[0]["tags"] == {"requestId": "req-w-2", "service": "worker"}
    for envelope in reports.envelopes:
        assert MARKER.encode() not in envelope.serialize()


async def test_an_unexpected_error_is_logged_and_reported(reports, json_logs):
    process = writing_job(StubConn(fail_with=RuntimeError("connection reset")), ai_service(200, []))

    with pytest.raises(RuntimeError):
        await process(job({"session_id": SESSION_ID, "request_id": "req-w-3"}), "token")

    reported = events(reports)
    assert len(reported) == 1
    assert reported[0]["tags"]["requestId"] == "req-w-3"
    assert reported[0]["exception"]["values"][-1]["value"] == "connection reset"
    failure = next(e for e in entries(json_logs) if e["msg"] == "job failed")
    assert failure["err"]["type"] == "RuntimeError"
    assert failure["requestId"] == "req-w-3"


async def test_the_nightly_batch_passes_its_request_id_to_every_learner_job():
    class FanoutConn(StubConn):
        async def fetch(self, *_args):
            return [{"learner_profile_id": uuid.uuid4()}, {"learner_profile_id": uuid.uuid4()}]

    class RecordingQueue:
        def __init__(self):
            self.added: list[dict] = []

        async def add(self, _name, data, _opts):
            self.added.append(data)

    queue = RecordingQueue()
    process = with_job_context(
        srs_batch_generation_task.make_processor(StubPool(FanoutConn()), queue, 14)  # type: ignore[arg-type]
    )

    await process(job({"request_id": "req-batch-1"}), "token")

    assert [data["request_id"] for data in queue.added] == ["req-batch-1", "req-batch-1"]


def test_scrub_event_drops_everything_that_can_carry_personal_data():
    event = scrub_event(
        {
            "request": {"url": "http://x/a?b=c", "data": {"essay_text": ESSAY}},
            "user": {"id": "u"},
            "extra": {"essay": ESSAY},
            "exception": {
                "values": [{"stacktrace": {"frames": [{"vars": {"essay_text": ESSAY}}]}}]
            },
            "breadcrumbs": {"values": [{"data": {"url": "http://x/a?b=c", "http.query": "b=c"}}]},
        },
        None,
    )

    assert event == {
        "request": {"url": "http://x/a"},
        "exception": {"values": [{"stacktrace": {"frames": [{}]}}]},
        "breadcrumbs": {"values": [{"data": {"url": "http://x/a"}}]},
    }
