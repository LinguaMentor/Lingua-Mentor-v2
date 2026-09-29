"""Writing Evaluation Engine — Master PRD §21.

Pipeline for one essay:
  assemble prompt (prompt_builder) → LLM call (high-tier, temp 0.1 per §19.3
  routing table) → schema validation with one correction retry (Brief §5.3)
  → deterministic composite score (§21.2) → exam-parameterised CEFR (§8.1).

The engine is pure orchestration: no DB access, no queue awareness. Callers
(router, worker task, calibration harness) persist results and AIModelRun
rows themselves — that's what keeps this engine reusable across all three.
"""

import json
from decimal import ROUND_HALF_UP, Decimal

from pydantic import ValidationError

from app.engines.writing_evaluation.exam_config import ExamConfig, load_exam_config
from app.engines.writing_evaluation.prompt_builder import (
    build_retry_message,
    build_scoring_messages,
)
from app.engines.writing_evaluation.schemas import (
    CategoryResult,
    LLMScoringOutput,
    WritingEvaluationResult,
)
from app.providers.llm.base import LLMMessage, LLMProvider, prompt_hash

# §19.3 routing: writing scoring = high-tier model, temperature 0.1
# ("high-stakes rubric scoring — top model + near-zero temperature").
SCORING_TEMPERATURE = 0.1
# Appeal re-marks (§21.4) run hotter so the secondary isn't a replay of the
# first, but still low enough to stay rubric-consistent.
APPEAL_TEMPERATURE = 0.3

_VARIANT_TEMPERATURES = {"primary": SCORING_TEMPERATURE, "appeal": APPEAL_TEMPERATURE}


class EvaluationError(Exception):
    """The model failed to produce a schema-valid evaluation after retry."""


def _parse_output(raw: str, config: ExamConfig) -> LLMScoringOutput:
    """Validate raw model output against schema AND rubric consistency."""
    output = LLMScoringOutput.model_validate(json.loads(raw))
    expected = {c.key for c in config.writing.rubric_categories}
    got = {c.key for c in output.categories}
    if got != expected:
        raise ValueError(f"category keys mismatch: expected {sorted(expected)}, got {sorted(got)}")
    return output


def compute_overall_band(output: LLMScoringOutput, config: ExamConfig) -> Decimal:
    """Composite formula (§21.2): Σ category × weight, rounded to the exam's
    increment (nearest 0.5 band). Deterministic — never asked of the model."""
    weights = {c.key: c.weight for c in config.writing.rubric_categories}
    weighted = sum(c.score * weights[c.key] for c in output.categories)
    increment = config.writing.score_scale.increment
    steps = (Decimal(weighted) / increment).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return (steps * increment).quantize(Decimal("0.01"))


async def evaluate_essay(
    provider: LLMProvider,
    *,
    exam_type: str,
    prompt_text: str,
    essay_text: str,
    model: str,
    target_band: str | None = None,
    cefr_writing: str | None = None,
    calibration_version: str | None = None,
    variant: str = "primary",
) -> WritingEvaluationResult:
    """Score one essay. Raises EvaluationError if the model can't produce a
    schema-valid result after one correction retry; raises UnknownExamError
    for an unconfigured exam_type.

    `variant="appeal"` runs the §21.4 secondary configuration: the independent
    re-mark prompt stance plus a different sampling temperature.
    """
    if variant not in _VARIANT_TEMPERATURES:
        raise ValueError(f"unknown evaluation variant: {variant!r}")
    temperature = _VARIANT_TEMPERATURES[variant]
    config = load_exam_config(exam_type)
    messages = build_scoring_messages(
        config,
        prompt_text=prompt_text,
        essay_text=essay_text,
        target_band=target_band,
        cefr_writing=cefr_writing,
        variant=variant,
    )

    response = await provider.complete(
        messages, model=model, temperature=temperature, json_mode=True
    )
    total_input_tokens = response.input_token_count
    total_output_tokens = response.output_token_count
    total_latency_ms = response.latency_ms

    try:
        output = _parse_output(response.content, config)
    except (json.JSONDecodeError, ValidationError, ValueError) as first_error:
        # One correction retry with the validation error included (Brief §5.3).
        retry_messages = [
            *messages,
            LLMMessage(role="assistant", content=response.content),
            build_retry_message(str(first_error)),
        ]
        response = await provider.complete(
            retry_messages, model=model, temperature=temperature, json_mode=True
        )
        total_input_tokens += response.input_token_count
        total_output_tokens += response.output_token_count
        total_latency_ms += response.latency_ms
        try:
            output = _parse_output(response.content, config)
        except (json.JSONDecodeError, ValidationError, ValueError) as second_error:
            raise EvaluationError(
                f"model output failed validation twice: {second_error}"
            ) from second_error

    overall = compute_overall_band(output, config)
    names = {c.key: c.name for c in config.writing.rubric_categories}
    weights = {c.key: c.weight for c in config.writing.rubric_categories}

    return WritingEvaluationResult(
        exam_type=exam_type,
        overall_band_score=overall,
        cefr_level=config.writing.cefr_for(overall),
        categories=[
            CategoryResult(
                key=c.key,
                name=names[c.key],
                score=c.score,
                weight=weights[c.key],
                feedback=c.feedback,
            )
            for c in output.categories
        ],
        grammar_corrections=output.grammar_corrections,
        vocabulary_suggestions=output.vocabulary_suggestions,
        calibration_version=calibration_version,
        provider=response.provider,
        model_name=response.model_name,
        model_version=response.model_version,
        prompt_hash=prompt_hash(messages),
        response_hash=response.response_hash,
        input_token_count=total_input_tokens,
        output_token_count=total_output_tokens,
        latency_ms=total_latency_ms,
    )
