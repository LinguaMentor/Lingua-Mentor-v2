"""FastAPI entry point. Mounts routers from app/api/v1/routers/ under /api/v1/*."""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.v1.routers import adaptive_learning, mentor, persona, placement, writing_eval
from app.core.config import Settings, get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.core.monitoring import init_monitoring
from app.core.request_id import RequestIdMiddleware
from app.db.session import close_pool, create_pool
from app.providers.llm.base import LLMProvider
from app.providers.llm.fake_provider import FakeProvider
from app.providers.llm.groq_provider import GroqProvider

configure_logging()
init_monitoring(get_settings())


def build_llm_provider(settings: Settings) -> LLMProvider:
    if settings.llm_provider == "fake":
        return FakeProvider()
    return GroqProvider(settings.groq_api_key)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    await create_pool()
    app.state.llm_provider = build_llm_provider(settings)
    try:
        yield
    finally:
        await app.state.llm_provider.aclose()
        await close_pool()


app = FastAPI(
    title="LinguaMentor AI Service",
    version="0.1.0",
    lifespan=lifespan,
    # OpenAPI served in non-prod only (PRD §34.3) — Coolify sets ENV=production.
)

register_error_handlers(app)
app.add_middleware(RequestIdMiddleware)

app.include_router(writing_eval.router, prefix="/api/v1")
app.include_router(placement.router, prefix="/api/v1")
app.include_router(adaptive_learning.router, prefix="/api/v1")
app.include_router(persona.router, prefix="/api/v1")
app.include_router(mentor.router, prefix="/api/v1")


@app.get("/health")
async def health() -> dict:
    """Public liveness probe (PRD §34.3)."""
    return {"status": "ok", "version": app.version}
