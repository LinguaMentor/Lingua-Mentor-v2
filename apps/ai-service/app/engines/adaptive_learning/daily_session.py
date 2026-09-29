"""Daily Diagnostic Micro-Session generation (Master PRD §15.2, §23.3, ADR 0009).

The SRS scheduler picks the dimension; this turns that into five minutes of
drill. Content is assembled through the §19.4 layer stack — persona included, so
the drill sounds like the learner's chosen tutor — and returned as JSON the
gateway caches under `srs_daily:{learner_profile_id}`.
"""

import json

from pydantic import BaseModel, Field, ValidationError

from app.engines.persona import build_persona_layer
from app.providers.llm.base import LLMMessage, LLMProvider, LLMResponse, prompt_hash

# §55: a drill is a low-complexity task, so it routes mid-tier. Length is capped
# for the same reason — a 5-minute session cannot need more than this.
DAILY_SESSION_MAX_TOKENS = 700
DAILY_SESSION_TEMPERATURE = 0.7

TARGET_DURATION_MINUTES = 5
EXERCISE_COUNT = 4

_SYSTEM_LAYER = (
    "You are LinguaMentor, an AI language tutor. You design short, focused "
    "practice for one skill at a time."
)

_POLICY_LAYER = """Non-negotiable constraints:
- Practise exactly the one skill dimension named below. Do not drift into others.
- Never state or imply an exam band, score, or CEFR level — this is practice,
  not assessment.
- No comments on the learner's identity, nationality, or presumed background.
- Every exercise must be answerable in under a minute by a learner at the level
  given, and must have a clear focus.
- Output a single valid JSON object matching the requested schema. No prose
  outside JSON."""

_DIMENSION_BRIEFS = {
    "grammar": "form, tense, agreement and sentence structure",
    "vocabulary": "word choice, collocation, precision and register",
    "coherence": "logical ordering, paragraphing and cohesive devices",
}


class Exercise(BaseModel):
    """One drill item.

    Carries no answer key on purpose: responses are AI-evaluated
    (§36 /mentor/evaluate-response), and an answer shipped to the client would
    make the skill-vector update it feeds meaningless.
    """

    item: str
    focus: str


class SessionContent(BaseModel):
    type: str
    prompt: str
    exercises: list[Exercise] = Field(min_length=1, max_length=6)
    estimated_duration_minutes: int


class DailySessionResult(BaseModel):
    content: SessionContent
    response: LLMResponse
    # Hashed here because this is where the messages exist; AIModelRun needs it
    # and a caller reconstructing the prompt to hash it would drift.
    prompt_hash: str

    model_config = {"arbitrary_types_allowed": True}


class DailySessionError(Exception):
    """Raised when the model can't produce a schema-valid session."""


def _task_layer(dimension: str) -> str:
    brief = _DIMENSION_BRIEFS[dimension]
    return f"""Task: build a {TARGET_DURATION_MINUTES}-minute practice session
targeting the learner's {dimension} — {brief}.

Produce exactly {EXERCISE_COUNT} exercises. `prompt` states, in one or two sentences, what the
learner should do across all of them. Each exercise carries the `item` to work on and a short
`focus` naming what it practises.

Return exactly this JSON shape:
{{
  "type": "{dimension}_drill",
  "prompt": "<string>",
  "exercises": [{{"item": "<string>", "focus": "<string>"}}, ...],
  "estimated_duration_minutes": {TARGET_DURATION_MINUTES}
}}"""


def _user_context_layer(*, language: str, cefr_level: str | None, target_exam: str | None) -> str:
    parts = [f"The learner is studying {language}."]
    if cefr_level:
        parts.append(f"Their assessed level is CEFR {cefr_level} — pitch the exercises there.")
    else:
        # No placement yet; guessing high would make the first session useless.
        parts.append("Their level is not yet assessed — pitch the exercises at B1.")
    if target_exam:
        parts.append(f"They are working toward {target_exam.replace('_', ' ')}.")
    return "Learner context: " + " ".join(parts)


def build_daily_session_messages(
    *,
    dimension: str,
    persona: str,
    tier: str,
    language: str,
    cefr_level: str | None = None,
    target_exam: str | None = None,
) -> list[LLMMessage]:
    """Assemble the §19.4 stack for one generation call.

    Layer 3 (persona) is present here and absent from scoring — a drill's tone
    is the learner's to choose, a rubric score is not (§17.3).
    """
    if dimension not in _DIMENSION_BRIEFS:
        raise DailySessionError(f"no drill defined for dimension '{dimension}'")
    system_content = "\n\n".join(
        [
            _SYSTEM_LAYER,
            _POLICY_LAYER,
            build_persona_layer(persona, tier=tier),
            _task_layer(dimension),
            _user_context_layer(language=language, cefr_level=cefr_level, target_exam=target_exam),
        ]
    )
    return [
        LLMMessage(role="system", content=system_content),
        LLMMessage(role="user", content=f"Generate today's {dimension} session."),
    ]


def parse_session_content(raw: str, dimension: str) -> SessionContent:
    content = SessionContent.model_validate(json.loads(raw))
    if content.type != f"{dimension}_drill":
        raise ValueError(f"model returned '{content.type}' for a {dimension} session")
    return content


async def generate_daily_session(
    provider: LLMProvider,
    *,
    dimension: str,
    persona: str,
    tier: str,
    language: str,
    model: str,
    cefr_level: str | None = None,
    target_exam: str | None = None,
) -> DailySessionResult:
    """Generate one day's drill. Raises DailySessionError on unusable output."""
    messages = build_daily_session_messages(
        dimension=dimension,
        persona=persona,
        tier=tier,
        language=language,
        cefr_level=cefr_level,
        target_exam=target_exam,
    )
    response = await provider.complete(
        messages,
        model=model,
        temperature=DAILY_SESSION_TEMPERATURE,
        max_tokens=DAILY_SESSION_MAX_TOKENS,
        json_mode=True,
    )
    try:
        content = parse_session_content(response.content, dimension)
    except (json.JSONDecodeError, ValidationError, ValueError) as err:
        # No retry: unlike a score, a missing drill costs the learner a slower
        # retry, not a wrong number. The batch will try again tomorrow.
        raise DailySessionError(f"model returned an unusable session: {err}") from err
    return DailySessionResult(content=content, response=response, prompt_hash=prompt_hash(messages))
