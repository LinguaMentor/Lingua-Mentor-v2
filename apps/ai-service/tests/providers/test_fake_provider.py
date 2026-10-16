"""The fake provider through the real engines, with every outbound connection refused."""

import socket
from decimal import Decimal

import pytest

from app.engines.adaptive_learning.daily_session import generate_daily_session
from app.engines.mentor_chat.chat import build_chat_messages
from app.engines.writing_evaluation.engine import evaluate_essay
from app.engines.writing_evaluation.exam_config import EXAMS_DIR, load_placement_task
from app.providers.llm.base import LLMMessage, LLMProviderError
from app.providers.llm.fake_provider import CHAT_REPLY, FakeProvider

pytestmark = pytest.mark.asyncio

EXAMS = sorted(p.stem for p in EXAMS_DIR.glob("*.yaml"))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("the fake provider opened a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


@pytest.mark.parametrize("exam_type", EXAMS)
@pytest.mark.parametrize("variant", ["primary", "appeal"])
async def test_every_exam_is_scored(exam_type, variant):
    result = await evaluate_essay(
        FakeProvider(),
        exam_type=exam_type,
        prompt_text="Discuss both views.",
        essay_text="Cities grow while villages empty.",
        model="any-model",
        variant=variant,
    )
    assert result.overall_band_score == Decimal("6.00")
    assert result.provider == "fake"
    assert result.cefr_level is not None


async def test_the_placement_task_is_scored():
    _, task = load_placement_task("ielts_academic")
    result = await evaluate_essay(
        FakeProvider(),
        exam_type="ielts_academic",
        prompt_text=task.prompt_text,
        essay_text="Cities grow while villages empty.",
        model="any-model",
    )
    assert result.overall_band_score == Decimal("6.00")


async def test_the_same_essay_gets_the_same_reply():
    async def score():
        return await evaluate_essay(
            FakeProvider(),
            exam_type="ielts_academic",
            prompt_text="Discuss both views.",
            essay_text="Cities grow while villages empty.",
            model="any-model",
        )

    first, second = await score(), await score()
    assert first.response_hash == second.response_hash
    assert first.prompt_hash == second.prompt_hash


@pytest.mark.parametrize("dimension", ["grammar", "vocabulary", "coherence"])
async def test_every_daily_drill_is_generated(dimension):
    result = await generate_daily_session(
        FakeProvider(),
        dimension=dimension,
        persona="companion",
        tier="free",
        language="en",
        model="any-model",
    )
    assert result.content.type == f"{dimension}_drill"
    assert len(result.content.exercises) == 4


async def test_chat_streams_a_fixed_reply():
    messages = build_chat_messages(
        message="I goes to school yesterday.",
        history=[],
        persona="companion",
        tier="free",
        language="en",
    )
    events = [e async for e in FakeProvider().stream(messages, model="any", temperature=0.7)]
    deltas = [e.delta for e in events if e.delta is not None]
    results = [e.result for e in events if e.result is not None]

    assert len(deltas) > 1
    assert "".join(deltas) == CHAT_REPLY
    assert len(results) == 1 and results[0].content == CHAT_REPLY
    assert events[-1].result is results[0]


async def test_an_unknown_json_task_is_an_error_not_a_guess():
    with pytest.raises(LLMProviderError):
        await FakeProvider().complete(
            [LLMMessage(role="system", content="Return some JSON.")],
            model="any",
            temperature=0,
            json_mode=True,
        )
