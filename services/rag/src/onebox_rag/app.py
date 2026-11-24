import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from redis.asyncio import Redis

from onebox_rag.auth import JwksVerifier, derive_internal_token
from onebox_rag.config import Settings
from onebox_rag.errors import register_error_handlers
from onebox_rag.health import HealthCheck, health_router
from onebox_rag.hub_routes import hub_router
from onebox_rag.index.embed import DenseEmbedder
from onebox_rag.index.points import SplitSettings
from onebox_rag.index.qdrant_store import QdrantStore, SearchTuning
from onebox_rag.index.upkeep import PointUpkeep
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.hub import FolderStore, KnowledgeBaseStore
from onebox_rag.ingest.hub_listing import HubLister
from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.inspect import Limits
from onebox_rag.ingest.organize import Organizer
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.ingest.repair import repair_orphans, requeue_stalled
from onebox_rag.logs import log_requests
from onebox_rag.mail.client import MailClient
from onebox_rag.mail.source import MailSource
from onebox_rag.models import Content
from onebox_rag.models.records import DateOrigin
from onebox_rag.mongo import mongo_client
from onebox_rag.parsers.ocr.rapid import OcrLimits
from onebox_rag.pipeline.classify import (
    ClassifyScheduler,
    ClassifySettings,
    ClassifyStage,
    SummaryPoint,
)
from onebox_rag.pipeline.describe import ImageDescriber
from onebox_rag.pipeline.docling_client import DoclingClient
from onebox_rag.pipeline.index import IndexStage
from onebox_rag.pipeline.llm import LlmClient
from onebox_rag.pipeline.ocr import OcrConfig, OcrProvider, OcrRunner, VisionCache
from onebox_rag.pipeline.parse import ParseStage, PdfInspection
from onebox_rag.pipeline.pool import ParsePool
from onebox_rag.pipeline.routing import PdfLimits
from onebox_rag.pipeline.tables import TableEnricher, TableSettings
from onebox_rag.pipeline.vision import VisionClient, VisionSettings
from onebox_rag.pipeline.worker import mail_worker, parse_worker, stage_worker
from onebox_rag.preferences import PreferenceStore, server_defaults
from onebox_rag.retrieval.service import RecordCut, Retriever, RetrieveSettings
from onebox_rag.retrieval.units import UnitSettings
from onebox_rag.routes import internal_router, rag_router

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


def vision_from(settings: Settings) -> VisionClient | None:
    if not settings.RAG_VISION_MODEL:
        return None
    return VisionClient(
        VisionSettings(
            base_url=settings.RAG_VISION_BASE_URL,
            model=settings.RAG_VISION_MODEL,
            api_key=settings.RAG_VISION_API_KEY,
            timeout_s=settings.RAG_VISION_TIMEOUT_S,
            max_tokens=settings.RAG_VISION_MAX_TOKENS,
            concurrency=settings.RAG_VISION_CONCURRENCY,
            retries=settings.RAG_VISION_RETRIES,
        )
    )


def ocr_config_from(settings: Settings) -> OcrConfig:
    return OcrConfig(
        provider=OcrProvider(settings.RAG_OCR_PROVIDER),
        limits=OcrLimits(dpi=settings.RAG_OCR_DPI, max_pages=settings.RAG_OCR_MAX_PAGES),
        base_timeout_s=settings.RAG_PARSE_TIMEOUT_S,
        seconds_per_page=settings.RAG_OCR_SECONDS_PER_PAGE,
    )


def retrieve_settings_from(settings: Settings) -> RetrieveSettings:
    return RetrieveSettings(
        tuning=SearchTuning(settings.RAG_SEARCH_HNSW_EF, settings.RAG_SEARCH_OVERSAMPLING),
        record_cut=RecordCut(enabled=settings.RAG_SEARCH_RECORD_CUT),
        title_min_score=settings.RAG_TITLE_MIN_SCORE,
        unindexed_max=settings.RAG_TITLE_UNINDEXED_MAX,
        outside_dates=settings.RAG_DATE_SAFETY_NET,
        uploads_undated=settings.RAG_CONTENT_DOCUMENT_DATES != "off",
        units=UnitSettings(
            small_table_cells=settings.RAG_SMALL_TABLE_CELLS,
            title_hit_words=settings.RAG_TITLE_HIT_WORDS,
        ),
    )


def classify_settings_from(settings: Settings) -> ClassifySettings:
    return ClassifySettings(
        enabled=settings.RAG_CLASSIFY,
        on_first_use=settings.RAG_CLASSIFY_ON_FIRST_USE,
        context_tokens=settings.RAG_CLASSIFY_CONTEXT_TOKENS,
        max_output_tokens=settings.RAG_CLASSIFY_MAX_OUTPUT_TOKENS,
    )


def content_dates_from(settings: Settings) -> frozenset[DateOrigin]:
    return {
        "off": frozenset(),
        "true": frozenset({DateOrigin.UPLOAD}),
        "all": frozenset({DateOrigin.UPLOAD, DateOrigin.LAST_MODIFIED}),
    }[settings.RAG_CONTENT_DOCUMENT_DATES]


def split_settings_from(settings: Settings) -> SplitSettings:
    return SplitSettings(
        max_block_chars=settings.RAG_INDEX_MAX_BLOCK_CHARS,
        window_chars=settings.RAG_INDEX_WINDOW_CHARS,
        window_overlap=settings.RAG_INDEX_WINDOW_OVERLAP,
        sentence_min_words=settings.RAG_INDEX_SENTENCE_MIN_WORDS,
        token_ceiling=settings.RAG_EMBED_TOKEN_CEILING,
        token_ratio=settings.RAG_EMBED_TOKEN_RATIO,
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


async def _sweep_undated(upkeep: PointUpkeep, every_s: float) -> None:
    while True:
        try:
            done = await upkeep.sweep()
            if done:
                logger.info("points caught up", extra={"items": done})
        except Exception:
            logger.warning("point upkeep sweep failed", exc_info=True)
        await asyncio.sleep(every_s)


async def _sweep_orphans(
    records: RecordStore, ingestor: Ingestor, mail: MailSource | None, every_s: float
) -> None:
    while True:
        try:
            await repair_orphans(records, ingestor, mail.repair if mail is not None else None)
            # Anything waiting longer than a sweep has lost its job (or never got one).
            await requeue_stalled(ingestor, datetime.now(UTC) - timedelta(seconds=every_s))
        except Exception:
            logger.warning("orphan sweep failed", exc_info=True)
        await asyncio.sleep(every_s)


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
        indexing = bool(settings.QDRANT_URL and settings.RAG_LLM_PROXY_URL)
        store = (
            QdrantStore(settings.QDRANT_URL, settings.QDRANT_API_KEY, settings.QDRANT_TIMEOUT_S)
            if indexing
            else None
        )
        index_queue = IngestQueue(settings, settings.RAG_INDEX_QUEUE) if indexing else None

        async def forget(content: Content) -> None:
            if store is not None and content.index_collection:
                await store.delete_content(content.index_collection, content.id)

        upkeep: PointUpkeep | None = None

        async def changed(content_id: str, added: list[str], removed: list[str]) -> None:
            if upkeep is not None:
                await upkeep.sync(content_id, added, removed)

        ingestor = Ingestor(
            records,
            contents,
            blobs,
            queue,
            limits_from(settings),
            index_queue=index_queue,
            forget=forget,
            changed=changed,
        )
        app.state.records, app.state.contents, app.state.blobs = records, contents, blobs
        app.state.ingestor = ingestor
        kbs, folders = (
            KnowledgeBaseStore(mongo[settings.MONGO_DB]),
            FolderStore(mongo[settings.MONGO_DB]),
        )
        app.state.hub = HubLister(kbs, folders, records)
        app.state.organizer = Organizer(kbs, folders, records, ingestor, lambda: datetime.now(UTC))
        preferences = PreferenceStore(mongo[settings.MONGO_DB], server_defaults(settings))
        app.state.preferences = preferences

        async def mongodb() -> object:
            return await mongo.admin.command("ping")

        async def redis_ping() -> object:
            return await redis.ping()

        app.state.checks = {"mongodb": mongodb, "redis": redis_ping, "blobs": blobs.ping}
        if store is not None:
            app.state.checks["qdrant"] = store.ping
        prepare = asyncio.create_task(
            _prepare_until_done(
                [
                    records.ensure_indexes,
                    contents.ensure_indexes,
                    blobs.ensure_bucket,
                    kbs.ensure_indexes,
                    folders.ensure_indexes,
                ]
            )
        )
        pool = pool_from(settings) if settings.RAG_RUN_WORKER else None
        docling = (
            DoclingClient(
                settings.RAG_DOCLING_URL, app.state.internal_token, settings.RAG_DOCLING_TIMEOUT_S
            )
            if settings.RAG_DOCLING_URL
            else None
        )
        vision = vision_from(settings) if pool is not None else None
        cache = VisionCache(blobs)
        ocr = (
            OcrRunner(
                pool, contents, ocr_config_from(settings), lambda: datetime.now(UTC), vision, cache
            )
            if pool is not None
            else None
        )
        describer = (
            ImageDescriber(vision, cache, settings.RAG_DESCRIBE_MAX_IMAGES)
            if vision is not None and settings.RAG_DESCRIBE_IMAGES
            else None
        )
        llm = (
            LlmClient(
                settings.RAG_LLM_PROXY_URL, app.state.internal_token, settings.RAG_LLM_TIMEOUT_S
            )
            if pool is not None and settings.RAG_LLM_PROXY_URL and settings.RAG_TABLE_ENRICHMENT
            else None
        )
        tables = (
            TableEnricher(
                llm,
                TableSettings(
                    max_llm_rows=settings.RAG_TABLE_LLM_ROWS,
                    batch_rows=settings.RAG_TABLE_ROW_BATCH,
                    concurrency=settings.RAG_TABLE_CONCURRENCY,
                    max_output_tokens=settings.RAG_TABLE_MAX_OUTPUT_TOKENS,
                ),
            )
            if llm is not None
            else None
        )
        worker = (
            parse_worker(
                settings,
                ParseStage(
                    contents,
                    records,
                    blobs,
                    ingestor,
                    pool,
                    pdf_inspection_from(settings),
                    docling,
                    ocr,
                    describer,
                    tables,
                    index_queue,
                ),
            )
            if pool is not None
            else None
        )
        dense = (
            DenseEmbedder(
                settings.RAG_LLM_PROXY_URL,
                app.state.internal_token,
                settings.RAG_EMBED_TIMEOUT_S,
                settings.RAG_EMBED_CONCURRENCY,
            )
            if store is not None
            else None
        )
        classify_settings = classify_settings_from(settings)
        classify_queue = (
            IngestQueue(settings, settings.RAG_CLASSIFY_QUEUE)
            if dense is not None and store is not None and settings.RAG_CLASSIFY
            else None
        )
        classify_llm = (
            LlmClient(
                settings.RAG_LLM_PROXY_URL, app.state.internal_token, settings.RAG_LLM_TIMEOUT_S
            )
            if classify_queue is not None
            else None
        )
        scheduler: ClassifyScheduler | None = None
        summary_point: SummaryPoint | None = None
        if dense is not None and store is not None:
            upkeep = PointUpkeep(contents, records, store, dense)
            summary_point = SummaryPoint(dense, store, split_settings_from(settings))
            if classify_queue is not None:
                scheduler = ClassifyScheduler(
                    contents,
                    classify_queue,
                    summary_point,
                    classify_settings,
                    prefs=preferences.get,
                )
            app.state.summaries_available = scheduler is not None
            app.state.retriever = Retriever(
                records,
                contents,
                blobs,
                dense,
                store,
                retrieve_settings_from(settings),
                # Any user may choose to summarize on first use.
                returned=scheduler.first_use if scheduler is not None else None,
            )
        mail = (
            MailSource(
                records,
                ingestor,
                MailClient(
                    settings.RAG_MAIL_URL, app.state.internal_token, settings.RAG_MAIL_TIMEOUT_S
                ),
                settings.RAG_MAX_FILE_MB * 1024 * 1024,
            )
            if settings.RAG_MAIL_URL and settings.RAG_RUN_WORKER
            else None
        )
        app.state.mail = mail
        mail_reader = mail_worker(settings, mail) if mail is not None else None
        indexer = (
            stage_worker(
                settings,
                settings.RAG_INDEX_QUEUE,
                IndexStage(
                    contents,
                    records,
                    blobs,
                    dense,
                    store,
                    split_settings_from(settings),
                    upkeep,
                    content_dates=content_dates_from(settings),
                    classify=scheduler.after_index if scheduler is not None else None,
                    prefs=preferences.get,
                    write_batch=settings.RAG_INDEX_WRITE_BATCH,
                    stray_max_points=settings.RAG_STRAY_SWEEP_MAX_POINTS,
                ),
                settings.RAG_INDEX_CONCURRENCY,
            )
            if dense is not None and store is not None and settings.RAG_RUN_WORKER
            else None
        )
        classifier = (
            stage_worker(
                settings,
                settings.RAG_CLASSIFY_QUEUE,
                ClassifyStage(
                    contents,
                    records,
                    blobs,
                    classify_llm,
                    summary_point,
                    classify_settings,
                    dated=upkeep.sync if upkeep is not None else None,
                ),
                settings.RAG_CLASSIFY_CONCURRENCY,
            )
            if classify_llm is not None and summary_point is not None and settings.RAG_RUN_WORKER
            else None
        )
        # Points indexed before they carried dates, or whose upkeep failed, catch up.
        sweep = (
            asyncio.create_task(_sweep_undated(upkeep, settings.RAG_UPKEEP_SWEEP_S))
            if upkeep is not None and settings.RAG_RUN_WORKER
            else None
        )
        orphans = (
            asyncio.create_task(
                _sweep_orphans(records, ingestor, mail, settings.RAG_UPKEEP_SWEEP_S)
            )
            if settings.RAG_RUN_WORKER
            else None
        )
        try:
            yield
        finally:
            prepare.cancel()
            if sweep is not None:
                sweep.cancel()
            if orphans is not None:
                orphans.cancel()
            if worker is not None:
                await worker.close()
            if indexer is not None:
                await indexer.close()
            if classifier is not None:
                await classifier.close()
            if classify_queue is not None:
                await classify_queue.close()
            if classify_llm is not None:
                await classify_llm.close()
            if mail_reader is not None:
                await mail_reader.close()
            if mail is not None:
                await mail.close()
            if dense is not None:
                await dense.close()
            if store is not None:
                await store.close()
            if index_queue is not None:
                await index_queue.close()
            if pool is not None:
                pool.close()
            if docling is not None:
                await docling.close()
            if vision is not None:
                await vision.close()
            if llm is not None:
                await llm.close()
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
    app.include_router(hub_router())
    app.include_router(internal_router())
    return app
