"""Request ids, JSON logs and error reports, through the whole ASGI app with a fake LLM and no database."""

import io
import json
import logging

import httpx
import pytest
import sentry_sdk
from sentry_sdk.transport import Transport

from app.api.v1.deps import get_db, get_llm_provider
from app.core.config import Settings
from app.core.logging import JsonFormatter
from app.core.monitoring import init_monitoring, scrub_event
from app.main import app
from tests.engines.writing_evaluation.test_engine import FakeProvider

# A known essay: if it shows up in a log line or an error report, the test fails.
ESSAY = "ESSAY-MARKER-31d7 Remote work has changed how cities plan their transport."
MARKER = "ESSAY-MARKER-31d7"
EVALUATE = "/api/v1/writing-eval/evaluate"


def evaluate_body() -> dict:
    # A given calibration version skips the baseline lookup, so the route never touches the database.
    return {
        "exam_type": "ielts_academic",
        "prompt_text": "Discuss.",
        "essay_text": ESSAY,
        "calibration_version": "test-v1",
    }


class ExplodingProvider(FakeProvider):
    async def complete(self, messages, *, model, temperature, max_tokens=None, json_mode=False):
        raise RuntimeError("provider exploded")


@pytest.fixture
def json_logs():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logging.getLogger().addHandler(handler)
    yield stream
    logging.getLogger().removeHandler(handler)


def entries(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def client_with(provider) -> httpx.AsyncClient:
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_llm_provider] = lambda: provider
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def clear_overrides():
    yield
    app.dependency_overrides.clear()


async def test_reuses_a_valid_request_id_and_logs_the_request_under_it(json_logs):
    async with client_with(FakeProvider([])) as client:
        response = await client.get(
            "/api/v1/writing-eval/exams", headers={"x-request-id": "req-ai-1"}
        )

    assert response.status_code == 200
    assert response.headers["x-request-id"] == "req-ai-1"
    completed = [e for e in entries(json_logs) if e["msg"] == "request completed"]
    assert completed[-1] | {"time": None, "durationMs": None} == {
        "time": None,
        "level": "info",
        "service": "ai-service",
        "logger": "app.request",
        "msg": "request completed",
        "requestId": "req-ai-1",
        "method": "GET",
        "path": "/api/v1/writing-eval/exams",
        "statusCode": 200,
        "durationMs": None,
    }


@pytest.mark.parametrize("incoming", ["", "two words", "a" * 129, "id\nforged"])
async def test_replaces_an_invalid_request_id(incoming):
    async with client_with(FakeProvider([])) as client:
        response = await client.get(
            "/api/v1/writing-eval/exams", headers={"x-request-id": incoming}
        )

    assert response.headers["x-request-id"] != incoming
    assert len(response.headers["x-request-id"]) == 36


async def test_a_failed_evaluation_keeps_the_essay_out_of_logs_and_the_response(json_logs):
    # The model echoes the essay into a field that fails validation, twice; pydantic's message would quote it.
    bad_output = json.dumps({"categories": ESSAY})
    async with client_with(FakeProvider([bad_output, bad_output])) as client:
        response = await client.post(
            EVALUATE, json=evaluate_body(), headers={"x-request-id": "req-ai-2"}
        )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "EVALUATION_FAILED"
    assert MARKER not in response.text
    assert MARKER not in json_logs.getvalue()
    assert any(e.get("requestId") == "req-ai-2" for e in entries(json_logs))


class RecordingTransport(Transport):
    def __init__(self, options=None):
        super().__init__(options)
        self.envelopes: list = []

    def capture_envelope(self, envelope):
        self.envelopes.append(envelope)


@pytest.fixture
def reports():
    transport = RecordingTransport()
    init_monitoring(
        Settings(
            sentry_dsn="http://publickey@127.0.0.1:9/4",
            sentry_environment="test-environment",
            sentry_release="0123abc",
        ),
        transport=transport,
    )
    yield transport
    sentry_sdk.get_global_scope().set_client(None)


async def test_an_unhandled_error_is_reported_with_its_context_and_without_the_essay(
    reports, json_logs
):
    async with client_with(ExplodingProvider([])) as client:
        response = await client.post(
            EVALUATE, json=evaluate_body(), headers={"x-request-id": "req-ai-3"}
        )
    sentry_sdk.flush()

    assert response.status_code == 500
    events = [envelope.get_event() for envelope in reports.envelopes if envelope.get_event()]
    assert len(events) == 1
    event = events[0]
    assert event["environment"] == "test-environment"
    assert event["release"] == "0123abc"
    assert event["tags"] == {"requestId": "req-ai-3", "service": "ai-service"}
    assert event["exception"]["values"][-1]["value"] == "provider exploded"
    assert event["request"] == {"url": "http://test/api/v1/writing-eval/evaluate"}
    for envelope in reports.envelopes:
        assert MARKER.encode() not in envelope.serialize()
    assert MARKER not in json_logs.getvalue()


def test_scrub_event_drops_everything_that_can_carry_personal_data():
    event = scrub_event(
        {
            "request": {
                "url": "http://ai-service/api/v1/placement/profile/x?learner=1#frag",
                "data": {"essay_text": ESSAY},
                "headers": {"x-request-id": "r"},
                "query_string": "learner=1",
            },
            "user": {"email": "learner@example.com"},
            "extra": {"essay": ESSAY},
            "exception": {
                "values": [{"stacktrace": {"frames": [{"vars": {"essay_text": ESSAY}}]}}]
            },
            "breadcrumbs": {
                "values": [
                    {"data": {"url": "http://x/a?b=c", "http.query": "b=c", "method": "GET"}}
                ]
            },
        },
        None,
    )

    assert event == {
        "request": {"url": "http://ai-service/api/v1/placement/profile/x"},
        "exception": {"values": [{"stacktrace": {"frames": [{}]}}]},
        "breadcrumbs": {"values": [{"data": {"url": "http://x/a", "method": "GET"}}]},
    }
