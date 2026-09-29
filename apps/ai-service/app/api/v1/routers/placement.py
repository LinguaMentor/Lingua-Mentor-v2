"""Placement + 4D CEFR profile routes — mounted under /api/v1/placement.

The placement test is the learner's first AI interaction (PRD §22.3). In Phase 1
it is writing-anchored: the learner's essay is scored by the Writing Evaluation
Engine, that CEFR level becomes the `writing` dimension, `reading` is proxied
from it (§22.1), and speaking/listening stay pending until the Voice pipeline
lands (Phase 2). Internal surface — the gateway is the user-facing caller.
"""

import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.v1.deps import get_db, get_llm_provider
from app.core.config import get_settings
from app.db.repositories import calibration_repository, model_run_repository, user_repository
from app.engines.cefr_profile import CefrProfile, placement_profile, profile_from_stored
from app.engines.writing_evaluation import evaluate_essay, load_placement_task
from app.providers.llm.base import LLMProvider

router = APIRouter(prefix="/placement", tags=["placement"])


class PlacementRequest(BaseModel):
    learner_profile_id: uuid.UUID
    # The exam whose rubric anchors the writing sample — the learner's target.
    exam_type: str
    # The task the learner answered. Only its id crosses the wire: the prompt
    # itself is read from config, so a caller can't choose what it's scored on.
    task_id: str = Field(min_length=1)
    essay_text: str = Field(min_length=1)


class PlacementTaskResponse(BaseModel):
    exam_type: str
    display_name: str
    task_name: str
    task_id: str
    prompt_text: str
    word_count_min: int


class DimensionOut(BaseModel):
    level: str | None
    source: str  # "assessed" | "proxy" | "pending"
    note: str | None = None


class CefrProfileResponse(BaseModel):
    learner_profile_id: uuid.UUID
    placement_completed: bool
    speaking: DimensionOut
    listening: DimensionOut
    reading: DimensionOut
    writing: DimensionOut


def _to_response(
    learner_profile_id: uuid.UUID, profile: CefrProfile, *, placement_completed: bool
) -> CefrProfileResponse:
    data = profile.to_dict()
    return CefrProfileResponse(
        learner_profile_id=learner_profile_id,
        placement_completed=placement_completed,
        **{skill: DimensionOut(**dim) for skill, dim in data.items()},
    )


@router.get("/task/{exam_type}", response_model=PlacementTaskResponse)
async def get_placement_task(exam_type: str) -> PlacementTaskResponse:
    """The essay task to set for this exam's placement test."""
    config, task = load_placement_task(exam_type)
    return PlacementTaskResponse(
        exam_type=config.exam_id,
        display_name=config.display_name,
        task_name=config.writing.task_name,
        task_id=task.task_id,
        prompt_text=task.prompt_text,
        word_count_min=task.word_count_min,
    )


@router.post("/evaluate", response_model=CefrProfileResponse)
async def evaluate_placement(
    body: PlacementRequest,
    conn: asyncpg.Connection = Depends(get_db),
    provider: LLMProvider = Depends(get_llm_provider),
) -> CefrProfileResponse:
    settings = get_settings()
    _, task = load_placement_task(body.exam_type)
    # Pin the task to the exam's own: a stale or forged id must not silently
    # score the learner against a prompt they never saw.
    if body.task_id != task.task_id:
        raise HTTPException(
            status_code=400, detail=f"task '{body.task_id}' is not the placement task for this exam"
        )
    # Same rule as scoring: record the active baseline. With the gate enforced
    # the gateway refuses placement pre-baseline, so NULL means a gate-off run.
    baseline = await calibration_repository.get_active_baseline(conn, body.exam_type)
    calibration_version = baseline["calibration_version"] if baseline else None
    result = await evaluate_essay(
        provider,
        exam_type=body.exam_type,
        prompt_text=task.prompt_text,
        essay_text=body.essay_text,
        model=settings.llm_model_high_tier,
        calibration_version=calibration_version,
    )
    # Traceability (PRD §28.2): the LLM ran, so an AIModelRun row must exist —
    # even though the placement result is a CEFR level, not a shown exam band.
    await model_run_repository.insert_run(
        conn,
        session_id=uuid.uuid4(),
        session_type="placement",
        task_type="placement_writing",
        provider=result.provider,
        model_name=result.model_name,
        model_version=result.model_version,
        prompt_hash=result.prompt_hash,
        response_hash=result.response_hash,
        input_token_count=result.input_token_count,
        output_token_count=result.output_token_count,
        latency_ms=result.latency_ms,
        was_fallback=result.was_fallback,
        calibration_version=result.calibration_version,
    )

    profile = placement_profile(result.cefr_level)
    updated = await user_repository.initialize_cefr_profile(
        conn,
        body.learner_profile_id,
        cefr_writing=profile.writing.level,
        cefr_reading=profile.reading.level,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="learner profile not found")

    return _to_response(body.learner_profile_id, profile, placement_completed=True)


@router.get("/profile/{learner_profile_id}", response_model=CefrProfileResponse)
async def get_cefr_profile(
    learner_profile_id: uuid.UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> CefrProfileResponse:
    row = await user_repository.get_learner_profile(conn, learner_profile_id)
    if row is None:
        raise HTTPException(status_code=404, detail="learner profile not found")
    profile = profile_from_stored(
        cefr_writing=row["cefr_writing"],
        cefr_reading=row["cefr_reading"],
        cefr_speaking=row["cefr_speaking"],
        cefr_listening=row["cefr_listening"],
    )
    return _to_response(
        learner_profile_id, profile, placement_completed=row["placement_completed_at"] is not None
    )
