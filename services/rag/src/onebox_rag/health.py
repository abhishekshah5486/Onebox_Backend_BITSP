import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

HealthCheck = Callable[[], Awaitable[object]]

CHECK_TIMEOUT_S = 5.0
logger = logging.getLogger("onebox_rag.health")


async def _run(check: HealthCheck) -> Literal["up", "down"]:
    try:
        await asyncio.wait_for(check(), CHECK_TIMEOUT_S)
    except Exception:
        return "down"
    return "up"


def health_router() -> APIRouter:
    """live = the process is running; ready = every dependency answered (as packages/http)."""
    router = APIRouter()

    @router.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/health/ready")
    async def ready(request: Request) -> JSONResponse:
        checks: Mapping[str, HealthCheck] = request.app.state.checks
        results = await asyncio.gather(*(_run(check) for check in checks.values()))
        report = dict(zip(checks, results, strict=True))
        ok = all(status == "up" for status in results)
        if not ok:
            logger.warning("readiness check failed", extra={"checks": report})
        return JSONResponse(
            {"status": "ok" if ok else "unavailable", "checks": report},
            status_code=200 if ok else 503,
        )

    return router
