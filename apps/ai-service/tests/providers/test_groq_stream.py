"""Groq streaming tests (PRD §19.5, §51) against a scripted SSE wire.

The chunk shapes here are copied from a real Groq response, including the
role-only opening chunk that makes naive first-token timing read ~0ms.
"""

import json

import httpx
import pytest

from app.providers.llm.base import LLMMessage, LLMProviderError
from app.providers.llm.groq_provider import GroqProvider

MESSAGES = [LLMMessage(role="user", content="hi")]


def _sse(*chunks: dict) -> bytes:
    lines = [f"data: {json.dumps(c)}\n\n" for c in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def _delta(content: str) -> dict:
    return {"model": "llama-3.1-8b-instant", "choices": [{"delta": {"content": content}}]}


ROLE_OPENER = {"choices": [{"delta": {"role": "assistant", "content": ""}}]}
USAGE_CHUNK = {
    "model": "llama-3.1-8b-instant",
    "choices": [],
    "usage": {"prompt_tokens": 43, "completion_tokens": 7},
}


def _provider(body: bytes, status: int = 200) -> GroqProvider:
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(
            status, content=body, headers={"content-type": "text/event-stream"}
        )
    )
    provider = GroqProvider("test-key")
    provider._client = httpx.AsyncClient(
        base_url="https://api.groq.com/openai/v1", transport=transport
    )
    return provider


async def _drain(provider: GroqProvider):
    deltas, result = [], None
    async for event in provider.stream(MESSAGES, model="llama-3.1-8b-instant", temperature=0.7):
        if event.delta is not None:
            deltas.append(event.delta)
        if event.result is not None:
            result = event.result
    return deltas, result


async def test_deltas_stream_then_the_result_arrives_last():
    provider = _provider(_sse(ROLE_OPENER, _delta("Hello"), _delta(" there"), USAGE_CHUNK))

    deltas, result = await _drain(provider)

    assert deltas == ["Hello", " there"]
    assert result is not None
    assert result.content == "Hello there"


async def test_the_role_only_opening_chunk_is_not_a_token():
    # Groq's first chunk is {"role": "assistant", "content": ""}. Counting it
    # would emit an empty delta and time first-token at ~0ms.
    provider = _provider(_sse(ROLE_OPENER, _delta("Hi"), USAGE_CHUNK))

    deltas, _ = await _drain(provider)

    assert deltas == ["Hi"]


async def test_first_token_ms_is_measured_and_reported():
    provider = _provider(_sse(ROLE_OPENER, _delta("Hi"), USAGE_CHUNK))

    _, result = await _drain(provider)

    assert result is not None
    assert result.first_token_ms is not None
    assert 0 <= result.first_token_ms <= result.latency_ms


async def test_a_stream_with_no_content_reports_no_first_token():
    # None, not 0: nothing arrived, and 0 would read as instant.
    provider = _provider(_sse(ROLE_OPENER, USAGE_CHUNK))

    _, result = await _drain(provider)

    assert result is not None
    assert result.first_token_ms is None


async def test_token_counts_come_from_the_usage_chunk():
    # stream_options.include_usage is why these aren't zeros (§11.5).
    provider = _provider(_sse(ROLE_OPENER, _delta("Hi"), USAGE_CHUNK))

    _, result = await _drain(provider)

    assert result is not None
    assert result.input_token_count == 43
    assert result.output_token_count == 7


async def test_the_served_model_is_taken_from_the_wire():
    provider = _provider(_sse(_delta("Hi"), USAGE_CHUNK))

    _, result = await _drain(provider)

    assert result is not None
    assert result.model_version == "llama-3.1-8b-instant"


async def test_a_rate_limit_is_retryable():
    provider = _provider(b'{"error":"slow down"}', status=429)

    with pytest.raises(LLMProviderError) as err:
        await _drain(provider)

    assert err.value.retryable is True


async def test_a_bad_request_is_not_retryable():
    provider = _provider(b'{"error":"bad model"}', status=400)

    with pytest.raises(LLMProviderError) as err:
        await _drain(provider)

    assert err.value.retryable is False
