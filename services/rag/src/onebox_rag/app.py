import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager

from fastapi import FastAPI
from redis.asyncio import Redis

from onebox_rag.auth import JwksVerifier, derive_internal_token
from onebox_rag.config import Settings
from onebox_rag.errors import register_error_handlers
from onebox_rag.health import HealthCheck, health_router
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.inspect import Limits
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.logs import log_requests
from onebox_rag.mongo import mongo_client
from onebox_rag.pipeline.parse import ParseStage, PdfInspection
from onebox_rag.pipeline.pool import ParsePool
from onebox_rag.pipeline.routing import PdfLimits
from onebox_rag.pipeline.worker import parse_worker
from onebox_rag.routes import rag_router

logger = logging.getLogger("onebox_rag.app")
PREPARE_RETRY_S = 5.0


def pool_from(settings: Settings) -> ParsePool:
    return ParsePool(
        settings.RAG_PARSE_WORKERS,
        timeout_s=settings.RAG_PARSE_TIMEOUT_S,
        memory_mb=settings.RAG_PARSE_MEMORY_MB,
        max_jobs_per_worker=settings.RAG_PARSE_WORKER_MAX_JOBS,
    )


def pdf_inspection_from(settings: Settings) -> PdfInspection:
    return PdfInspection(
        sample_pages=settings.RAG_PDF_OCR_SAMPLE_PAGES,
        ocr_share=settings.RAG_PDF_OCR_PAGE_SHARE,
        limits=PdfLimits(
            docling_max_pages=settings.RAG_DOCLING_MAX_PAGES,
            docling_max_bytes=settings.RAG_DOCLING_MAX_MB * 2**20,
        ),
    )


def limits_from(settings: Settings) -> Limits:
    return Limits(
        max_bytes=settings.RAG_MAX_FILE_MB * 2**20,
        max_unzipped_bytes=settings.RAG_MAX_UNZIPPED_MB * 2**20,
        max_zip_ratio=settings.RAG_MAX_ZIP_RATIO,
        max_zip_entries=settings.RAG_MAX_ZIP_ENTRIES,
    )


async def _prepare_until_done(steps: list[Callable[[], Awaitable[None]]]) -> None:
    """Indexes and the bucket, retried while their stores are down (readiness reports it)."""
    pending = list(steps)
    while pending:
        try:
            await pending[0]()
            pending.pop(0)
        except Exception:
            logger.warning("startup step failed; retrying", exc_info=True)
            await asyncio.sleep(PREPARE_RETRY_S)


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
        records = RecordStore(mongo[settings.MONGO_DB])
        contents = ContentStore(mongo[settings.MONGO_DB])
        blobs = BlobStore(settings)
        queue = IngestQueue(settings)
        ingestor = Ingestor(records, contents, blobs, queue, limits_from(settings))
        app.state.records, app.state.contents, app.state.blobs = records, contents, blobs
        app.state.ingestor = ingestor

        async def mongodb() -> object:
            return await mongo.admin.command("ping")

        async def redis_ping() -> object:
            return await redis.ping()

        app.state.checks = {"mongodb": mongodb, "redis": redis_ping, "blobs": blobs.ping}
        prepare = asyncio.create_task(
            _prepare_until_done(
                [records.ensure_indexes, contents.ensure_indexes, blobs.ensure_bucket]
            )
        )
        pool = pool_from(settings) if settings.RAG_RUN_WORKER else None
        worker = (
            parse_worker(
                settings,
                ParseStage(contents, records, blobs, ingestor, pool, pdf_inspection_from(settings)),
            )
            if pool is not None
            else None
        )
        try:
            yield
        finally:
            prepare.cancel()
            if worker is not None:
                await worker.close()
            if pool is not None:
                pool.close()
            await queue.close()
            await redis.aclose()
            await mongo.close()

    app = FastAPI(title="OneBox RAG", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.verifier = verifier or JwksVerifier(settings.AUTH_SERVICE_URL)
    app.state.internal_token = derive_internal_token(settings.CREDENTIALS_ENCRYPTION_KEY)
    app.middleware("http")(log_requests)
    register_error_handlers(app)
    app.include_router(health_router())
    app.include_router(rag_router())
    return app
