from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager

from fastapi import FastAPI
from redis.asyncio import Redis

from onebox_rag.auth import JwksVerifier, derive_internal_token
from onebox_rag.config import Settings
from onebox_rag.errors import register_error_handlers
from onebox_rag.health import HealthCheck, health_router
from onebox_rag.logs import log_requests
from onebox_rag.mongo import mongo_client


def create_app(
    settings: Settings,
    *,
    verifier: JwksVerifier | None = None,
    checks: Mapping[str, HealthCheck] | None = None,
) -> FastAPI:
    """The HTTP app. Tests pass their own verifier and checks; otherwise MongoDB and Redis are
    connected for the app's lifetime and checked by /health/ready."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if checks is not None:
            app.state.checks = checks
            yield
            return
        mongo = mongo_client(settings.MONGO_URI)
        redis = Redis.from_url(settings.REDIS_URL)
        app.state.mongo = mongo
        app.state.db = mongo[settings.MONGO_DB]
        app.state.redis = redis

        async def mongodb() -> object:
            return await mongo.admin.command("ping")

        async def redis_ping() -> object:
            return await redis.ping()

        app.state.checks = {"mongodb": mongodb, "redis": redis_ping}
        try:
            yield
        finally:
            await redis.aclose()
            await mongo.close()

    app = FastAPI(title="OneBox RAG", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.verifier = verifier or JwksVerifier(settings.AUTH_SERVICE_URL)
    app.state.internal_token = derive_internal_token(settings.CREDENTIALS_ENCRYPTION_KEY)
    app.middleware("http")(log_requests)
    register_error_handlers(app)
    app.include_router(health_router())
    return app
