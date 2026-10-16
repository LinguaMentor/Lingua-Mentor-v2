"""Fake LLM provider for local, CI and end-to-end runs: fixed replies, no network.

It recognises the task from the assembled prompt and answers in the shape that
task's parser validates. A JSON task it can't recognise is an error, so a prompt
change that breaks recognition fails the tests instead of scoring nothing.
"""

import json
import re
from collections.abc import AsyncIterator

from app.providers.llm.base import (
    LLMMessage,
    LLMProvider,
    LLMProviderError,
    LLMResponse,
    LLMStreamEvent,
    LLMStreamResult,
)

# The scoring rubric layer lists each category as "[key] Name (weight 0.25)".
_RUBRIC_KEY_RE = re.compile(r"^\[([a-z_]+)\] .+ \(weight [0-9.]+\)$", re.MULTILINE)
# The daily-session task layer asks for "type": "<dimension>_drill".
_DRILL_TYPE_RE = re.compile(r'"type": "([a-z]+)_drill"')

FAKE_SCORE = 6.0
FAKE_MODEL_VERSION = "fake"
CHAT_REPLY = (
    "This is a fixed reply from the fake provider. "
    "Your sentence is clear; try a linking word such as 'however' to join the two ideas."
)


def _scoring_reply(keys: list[str]) -> dict:
    return {
        "categories": [
            {"key": key, "score": FAKE_SCORE, "feedback": f"Fixed feedback for {key}."}
            for key in keys
        ],
        "grammar_corrections": [
            {
                "original": "peoples",
                "correction": "people",
                "explanation": "'People' is already plural.",
            }
        ],
        "vocabulary_suggestions": [
            {"original": "good", "suggestion": "beneficial", "reason": "More precise here."}
        ],
    }


def _drill_reply(dimension: str) -> dict:
    return {
        "type": f"{dimension}_drill",
        "prompt": f"Work through these four short {dimension} exercises.",
        "exercises": [
            {"item": f"Fixed {dimension} exercise {n}.", "focus": dimension} for n in range(1, 5)
        ],
        "estimated_duration_minutes": 5,
    }


def _reply(messages: list[LLMMessage], *, json_mode: bool) -> str:
    system = next((m.content for m in messages if m.role == "system"), "")
    if keys := _RUBRIC_KEY_RE.findall(system):
        return json.dumps(_scoring_reply(keys))
    if drill := _DRILL_TYPE_RE.search(system):
        return json.dumps(_drill_reply(drill.group(1)))
    if json_mode:
        raise LLMProviderError("the fake provider has no reply for this JSON task")
    return CHAT_REPLY


def _tokens(text: str) -> int:
    return len(text.split())


class FakeProvider(LLMProvider):
    name = "fake"

    async def complete(
        self,
        messages: list[LLMMessage],
        *,
        model: str,
        temperature: float,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        content = _reply(messages, json_mode=json_mode)
        return LLMResponse(
            content=content,
            provider=self.name,
            model_name=model,
            model_version=FAKE_MODEL_VERSION,
            input_token_count=sum(_tokens(m.content) for m in messages),
            output_token_count=_tokens(content),
            latency_ms=0,
        )

    async def stream(
        self,
        messages: list[LLMMessage],
        *,
        model: str,
        temperature: float,
        max_tokens: int | None = None,
    ) -> AsyncIterator[LLMStreamEvent]:
        words = CHAT_REPLY.split(" ")
        for index, word in enumerate(words):
            yield LLMStreamEvent(delta=word if index == 0 else f" {word}")
        yield LLMStreamEvent(
            result=LLMStreamResult(
                content=CHAT_REPLY,
                provider=self.name,
                model_name=model,
                model_version=FAKE_MODEL_VERSION,
                input_token_count=sum(_tokens(m.content) for m in messages),
                output_token_count=_tokens(CHAT_REPLY),
                latency_ms=0,
                first_token_ms=0,
            )
        )

    async def aclose(self) -> None:
        return None
