import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware

from onebox_rag.auth import derive_internal_token, require_internal
from onebox_rag.docling.config import DoclingSettings
from onebox_rag.docling.convert import ConvertOptions, convert_document, warm_up
from onebox_rag.errors import register_error_handlers
from onebox_rag.health import health_router
from onebox_rag.logs import log_requests
from onebox_rag.parsers.base import UnreadableFileError
from onebox_rag.pipeline.pool import ParsePool, ParseWorkerError

logger = logging.getLogger("onebox_rag.docling")
TARGETS = {"pdf", "docx", "pptx"}
LEGACY = {"doc", "rtf", "odt", "ppt", "odp"}


def options_from(settings: DoclingSettings) -> ConvertOptions:
    return ConvertOptions(
        table_mode=settings.DOCLING_TABLE_MODE,
        images_scale=settings.DOCLING_IMAGES_SCALE,
        timeout_s=settings.DOCLING_TIMEOUT_S,
        soffice=settings.SOFFICE_PATH,
        ocr=settings.DOCLING_OCR == "rapidocr",
    )


def _error(status: int, code: str, reason: str) -> JSONResponse:
    return JSONResponse({"code": code, "reason": reason}, status_code=status)


def create_docling_app(settings: DoclingSettings) -> FastAPI:
    options = options_from(settings)
    capacity = settings.DOCLING_WORKERS + settings.DOCLING_MAX_QUEUED

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        pool = ParsePool(
            settings.DOCLING_WORKERS,
            timeout_s=settings.DOCLING_TIMEOUT_S,
            memory_mb=settings.DOCLING_MEMORY_MB,
            max_jobs_per_worker=settings.DOCLING_WORKER_MAX_JOBS,
        )
        warm = asyncio.Event()

        async def warm_workers() -> None:
            # Loads the models before the first file; ready reports down until then.
            try:
                await asyncio.gather(
                    *(
                        pool.run(warm_up, options, label="warm-up")
                        for _ in range(settings.DOCLING_WORKERS)
                    )
                )
                warm.set()
            except Exception:
                logger.exception("docling warm-up failed")

        async def models() -> None:
            if not warm.is_set():
                raise RuntimeError("models are loading")

        app.state.pool, app.state.in_flight = pool, 0
        app.state.checks = {"models": models}
        warming = asyncio.create_task(warm_workers())
        try:
            yield
        finally:
            warming.cancel()
            pool.close()

    app = FastAPI(title="OneBox Docling", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.internal_token = derive_internal_token(settings.CREDENTIALS_ENCRYPTION_KEY)
    app.middleware("http")(log_requests)
    # Documents come back as large JSON; RAG's httpx client undoes this.
    app.add_middleware(GZipMiddleware, minimum_size=4096)
    register_error_handlers(app)
    app.include_router(health_router())

    @app.post("/convert", dependencies=[Depends(require_internal)], response_model=None)
    async def convert(
        request: Request,
        file: Annotated[UploadFile, File()],
        target: Annotated[str, Form()],
        legacy_ext: Annotated[str | None, Form(alias="legacyExt")] = None,
    ) -> dict[str, Any] | JSONResponse:
        if target not in TARGETS or (legacy_ext is not None and legacy_ext not in LEGACY):
            return _error(400, "BAD_FORMAT", f"can't convert {legacy_ext or target}")
        if request.app.state.in_flight >= capacity:
            return _error(429, "BUSY", "every Docling worker is busy")
        request.app.state.in_flight += 1
        try:
            data = await file.read()
            pool: ParsePool = request.app.state.pool
            document: dict[str, Any] = await pool.run(
                convert_document, data, target, legacy_ext, options, label=file.filename or "file"
            )
            return document
        except UnreadableFileError as err:
            return _error(422, "UNREADABLE", str(err) or "unreadable")
        except ParseWorkerError as err:
            if err.cause == "timed_out":
                return _error(422, "TIMED_OUT", str(err))
            return _error(
                503, "WORKER_KILLED" if err.cause == "killed" else "WORKER_DIED", str(err)
            )
        finally:
            request.app.state.in_flight -= 1

    return app
