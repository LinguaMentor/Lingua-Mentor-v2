"""httpx client for ai-service's internal evaluation endpoint.

Error taxonomy mirrors ai-service's envelope semantics (app/core/errors.py):
4xx means the input can never succeed (unknown exam, validation) — retrying
is pointless; 5xx/timeouts are transient — BullMQ should retry.
"""

from uuid import UUID

import httpx

from app.log_config import REQUEST_ID_HEADER, request_id_var

EVALUATE_PATH = "/api/v1/writing-eval/evaluate"
APPEAL_PATH = "/api/v1/writing-eval/appeal"
DAILY_DIAGNOSTIC_PATH = "/api/v1/mentor/daily-diagnostic"


async def _send_request_id(request: httpx.Request) -> None:
    request_id = request_id_var.get()
    if request_id:
        request.headers[REQUEST_ID_HEADER] = request_id


def make_client(
    base_url: str, transport: httpx.AsyncBaseTransport | None = None
) -> httpx.AsyncClient:
    """Every call carries the job's request id, so ai-service logs under the same id."""
    return httpx.AsyncClient(
        base_url=base_url,
        # Read timeout must outlive a full LLM evaluation — httpx's 5s default
        # would kill every real scoring call.
        timeout=httpx.Timeout(120.0, connect=10.0),
        event_hooks={"request": [_send_request_id]},
        transport=transport,
    )


class TerminalEvalError(Exception):
    """4xx from ai-service: bad input — no retry can fix it."""


class RetryableEvalError(Exception):
    """502/5xx/timeout/transport failure: transient — worth a retry."""


def _envelope_message(response: httpx.Response) -> str:
    try:
        error = response.json()["error"]
        return f"{error['code']}: {error['message']}"
    except Exception:
        return f"HTTP {response.status_code}"


async def evaluate_writing(
    http: httpx.AsyncClient,
    *,
    exam_type: str,
    prompt_text: str,
    essay_text: str,
    session_id: UUID,
    calibration_version: str | None,
) -> dict:
    try:
        response = await http.post(
            EVALUATE_PATH,
            json={
                "exam_type": exam_type,
                "prompt_text": prompt_text,
                "essay_text": essay_text,
                "session_id": str(session_id),
                # Ties the AIModelRun row ai-service logs to this submission.
                "session_type": "submission",
                "calibration_version": calibration_version,
            },
        )
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise RetryableEvalError(str(exc)) from exc

    if response.status_code == 200:
        return response.json()
    if 400 <= response.status_code < 500:
        raise TerminalEvalError(_envelope_message(response))
    raise RetryableEvalError(_envelope_message(response))


async def evaluate_appeal(
    http: httpx.AsyncClient,
    *,
    exam_type: str,
    prompt_text: str,
    essay_text: str,
    appeal_id: UUID,
    calibration_version: str | None,
) -> dict:
    """Secondary evaluation for a score appeal (PRD §21.4) — ai-service runs
    its appeal variant (independent re-mark prompt, different temperature)."""
    try:
        response = await http.post(
            APPEAL_PATH,
            json={
                "exam_type": exam_type,
                "prompt_text": prompt_text,
                "essay_text": essay_text,
                "appeal_id": str(appeal_id),
                "calibration_version": calibration_version,
            },
        )
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise RetryableEvalError(str(exc)) from exc

    if response.status_code == 200:
        return response.json()
    if 400 <= response.status_code < 500:
        raise TerminalEvalError(_envelope_message(response))
    raise RetryableEvalError(_envelope_message(response))


async def generate_daily_session(http: httpx.AsyncClient, *, learner_profile_id: UUID) -> dict:
    """Ask ai-service for today's drill. Same 4xx/5xx taxonomy as above."""
    try:
        response = await http.post(
            DAILY_DIAGNOSTIC_PATH,
            json={"learner_profile_id": str(learner_profile_id)},
        )
    except httpx.HTTPError as err:
        raise RetryableEvalError(f"ai-service unreachable: {err}") from err

    if response.is_success:
        return response.json()
    if 400 <= response.status_code < 500:
        raise TerminalEvalError(_envelope_message(response))
    raise RetryableEvalError(_envelope_message(response))
