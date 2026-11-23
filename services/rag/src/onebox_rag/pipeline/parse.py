import dataclasses
import gzip
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import TERMINAL, Attachment, Content, Stage, Status
from onebox_rag.models.blocks import BlocksContainer
from onebox_rag.parsers.base import ParseResult, ProtectedFileError, UnreadableFileError
from onebox_rag.parsers.docling_blocks import parse_docling_document
from onebox_rag.parsers.excel import legacy_sheet, parse_excel
from onebox_rag.parsers.office import office_format
from onebox_rag.parsers.pdf.inspection import PdfFacts, inspect_pdf
from onebox_rag.parsers.pdf.pdfplumber_engine import parse_pdf_layout
from onebox_rag.parsers.registry import EXCEL, parser_for
from onebox_rag.pipeline.describe import ImageDescriber
from onebox_rag.pipeline.docling_client import DoclingClient, DoclingUnavailableError
from onebox_rag.pipeline.ocr import OcrRunner
from onebox_rag.pipeline.pool import ParsePool, ParseWorkerError
from onebox_rag.pipeline.routing import (
    IMAGE_TYPES,
    PDF,
    PdfEngine,
    PdfLimits,
    Route,
    parser_for_engine,
    route_pdf,
)
from onebox_rag.pipeline.tables import TableEnricher

logger = logging.getLogger("onebox_rag.parse")


def encode_blocks(container: BlocksContainer) -> bytes:
    return gzip.compress(container.model_dump_json(by_alias=True, exclude_none=True).encode())


def decode_blocks(data: bytes) -> BlocksContainer:
    return BlocksContainer.model_validate_json(gzip.decompress(data))


@dataclass(frozen=True)
class PdfInspection:
    sample_pages: int
    ocr_share: float
    limits: PdfLimits


class ParseStage:
    """Steps 2 and 3: route a content to an engine, parse it in the pool, store its blocks, and
    move every record holding it on."""

    def __init__(
        self,
        contents: ContentStore,
        records: RecordStore,
        blobs: BlobStore,
        ingestor: Ingestor,
        pool: ParsePool,
        pdf: PdfInspection,
        docling: DoclingClient | None = None,
        ocr: OcrRunner | None = None,
        describer: ImageDescriber | None = None,
        tables: TableEnricher | None = None,
        index_queue: IngestQueue | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._contents, self._records, self._blobs = contents, records, blobs
        self._ingestor, self._pool, self._pdf, self._now = ingestor, pool, pdf, now
        self._docling, self._ocr, self._describer = docling, ocr, describer
        self._tables, self._index_queue = tables, index_queue

    async def run(self, content_id: str, revision: int, *, final_attempt: bool) -> None:
        content = await self._contents.get(content_id)
        # Deleted, superseded by a newer revision, or already done: nothing to do.
        if (
            content is None
            or content.revision != revision
            or content.status in TERMINAL
            or content.stage != Stage.PARSE
            or content.blob_key is None
        ):
            return
        data = await self._blobs.get(content.blob_key)
        route = await self._route(content, data)
        if route is None:
            await self._settle(
                content,
                Status.FILE_TYPE_NOT_SUPPORTED,
                reason=f"{content.mime_type} can't be read yet",
            )
            return
        parse = self._parser(content, data, route.engine)
        if parse is None:
            reason = f"waiting for the {route.engine} engine"
            await self._settle(content, Status.FILE_TYPE_NOT_SUPPORTED, reason=reason)
            return
        await self._settle(content, Status.IN_PROGRESS, stage=Stage.PARSE)
        try:
            result = await parse()
            problems = result.container.problems()
            if problems:
                raise ValueError(f"{route.engine} built a broken container: {problems[:3]}")
        except ProtectedFileError as err:
            await self._settle(content, Status.PASSWORD_PROTECTED, reason=str(err))
            return
        except UnreadableFileError as err:
            await self._settle(content, Status.FAILED, reason=str(err) or "unreadable")
            return
        except ParseWorkerError as err:
            await self._worker_failed(content, err, final_attempt)
            raise
        except DoclingUnavailableError as err:
            logger.warning("docling unavailable", extra={"contentId": content_id, "why": str(err)})
            await self._retry_or_fail(content, final_attempt, "the Docling service is unavailable")
            raise
        except Exception:
            logger.exception(
                "parse failed", extra={"contentId": content_id, "final": final_attempt}
            )
            await self._retry_or_fail(content, final_attempt, "could not be parsed")
            raise
        await self._store(content, revision, result, route.engine)

    def _parser(
        self, content: Content, data: bytes, engine: str
    ) -> Callable[[], Awaitable[ParseResult]] | None:
        """How the engine parses this content, or None while that engine isn't available."""
        label = f"content {content.id}"
        if engine == PdfEngine.OCR:
            ocr = self._ocr
            if ocr is None:
                return None

            async def with_ocr() -> ParseResult:
                assert ocr is not None
                return await ocr.parse(content, data)

            return with_ocr
        sheet_ext = legacy_sheet(content.mime_type)
        if engine == EXCEL.engine and sheet_ext is not None:
            docling = self._docling
            if docling is None:
                return None

            async def converted() -> ParseResult:
                assert docling is not None and sheet_ext is not None
                xlsx = await docling.to_xlsx(data, sheet_ext, name=content.id)
                result: ParseResult = await self._pool.run(parse_excel, xlsx, label=label)
                return result

            return converted
        office = office_format(content.mime_type)
        if engine == PdfEngine.DOCLING and office is not None:
            docling = self._docling
            # A PDF can still be read without Docling, with pdfplumber.
            is_pdf = office.docling == "pdf"
            if docling is None:
                return self._without_docling(content, data) if is_pdf else None

            async def with_docling() -> ParseResult:
                assert docling is not None and office is not None
                try:
                    document = await docling.convert(data, office, name=content.id)
                except DoclingUnavailableError as err:
                    if not is_pdf:
                        raise
                    logger.warning(
                        "docling unavailable; using pdfplumber",
                        extra={"contentId": content.id, "why": str(err)},
                    )
                    return await self._without_docling(content, data)()
                slides = office.docling == "pptx"
                result: ParseResult = await self._pool.run(
                    parse_docling_document, document, slides, label=label
                )
                return result

            return with_docling
        parser = parser_for_engine(content.mime_type, engine)
        if parser is None:
            return None

        async def locally() -> ParseResult:
            assert parser is not None
            result: ParseResult = await self._pool.run(
                parser.parse, data, content.mime_type, label=label
            )
            return result

        return locally

    def _without_docling(
        self, content: Content, data: bytes
    ) -> Callable[[], Awaitable[ParseResult]]:
        async def with_pdfplumber() -> ParseResult:
            # Recorded, so a retry of this revision uses the same engine.
            await self._contents.update(
                content.id,
                self._now(),
                engine=PdfEngine.PDFPLUMBER,
                engine_reason="docling_unavailable",
            )
            result: ParseResult = await self._pool.run(
                parse_pdf_layout, data, content.mime_type, label=f"content {content.id}"
            )
            return result

        return with_pdfplumber

    async def _route(self, content: Content, data: bytes) -> Route | None:
        """The recorded route, or a new one recorded now."""
        if content.engine and content.engine_reason:
            return Route(content.engine, content.engine_reason)
        facts: PdfFacts | None = None
        if content.mime_type == PDF:
            try:
                facts = await self._pool.run(
                    inspect_pdf, data, self._pdf.sample_pages, self._pdf.ocr_share, label="inspect"
                )
            except ParseWorkerError:
                raise
            except Exception:
                # Best effort: without facts the size decides.
                logger.warning(
                    "pdf inspection failed", extra={"contentId": content.id}, exc_info=True
                )
            route = route_pdf(facts, content.size_bytes, self._pdf.limits)
        elif office_format(content.mime_type) is not None:
            route = Route(PdfEngine.DOCLING, "format")
        elif content.mime_type in IMAGE_TYPES:
            route = Route(PdfEngine.OCR, "image")
        elif legacy_sheet(content.mime_type) is not None:
            # Converted to XLSX by the Docling service's LibreOffice, then read like one.
            route = Route(EXCEL.engine, "converted")
        else:
            parser = parser_for(content.mime_type)
            if parser is None:
                return None
            route = Route(parser.engine, "format")
        await self._contents.update(
            content.id,
            self._now(),
            engine=route.engine,
            engine_reason=route.reason,
            facts=dataclasses.asdict(facts) if facts else None,
        )
        logger.info(
            "routed",
            extra={"contentId": content.id, "engine": route.engine, "why": route.reason},
        )
        return route

    async def _worker_failed(self, content: Content, err: ParseWorkerError, final: bool) -> None:
        if err.cause == "timed_out":
            # The same file would only time out again.
            await self._settle(content, Status.FAILED, reason=str(err))
        elif err.cause == "killed":
            # The kernel kills the biggest-looking worker, not always the one at fault: one
            # more try, and a second death means the file needs more memory than it has.
            deaths = content.worker_deaths + 1
            await self._contents.update(content.id, self._now(), worker_deaths=deaths)
            if deaths >= 2:
                await self._settle(content, Status.FAILED, reason="needs more memory than allowed")
            else:
                await self._settle(content, Status.QUEUED, stage=Stage.PARSE)
        else:
            await self._retry_or_fail(content, final, str(err))

    async def _retry_or_fail(self, content: Content, final: bool, reason: str) -> None:
        if final:
            await self._settle(content, Status.FAILED, reason=reason)
        else:
            # Back to queued, so the retry passes the checks in run().
            await self._settle(content, Status.QUEUED, stage=Stage.PARSE)

    async def _store(
        self, content: Content, revision: int, result: ParseResult, engine: str
    ) -> None:
        attachments = []
        for file in result.attachments:
            child = await self._ingestor.store_extracted(content.user_id, file)
            attachments.append(
                Attachment(name=file.name, mime_type=child.mime_type, content_id=child.id)
            )
        if self._tables is not None:
            sentences = await self._tables.enrich(content.user_id, result.container)
            if sentences:
                logger.info("described rows", extra={"contentId": content.id, "rows": sentences})
        if self._describer is not None:
            described = await self._describer.describe(content.user_id, result.container)
            if described:
                logger.info("described images", extra={"contentId": content.id, "count": described})
        if not result.container.has_text() and not attachments:
            await self._settle(content, Status.EMPTY, reason="no text to index")
            return
        blocks_key = f"{content.user_id}/contents/{content.id}/blocks-r{revision}.json.gz"
        await self._blobs.put_bytes(blocks_key, encode_blocks(result.container), "application/gzip")
        # Parsed; indexing (milestone 9) picks it up from here.
        settled = await self._settle(
            content,
            Status.QUEUED,
            stage=Stage.INDEX,
            blocks_key=blocks_key,
            block_count=len(result.container.blocks),
            attachments=[a.model_dump(by_alias=True) for a in attachments],
        )
        if settled is not None and self._index_queue is not None:
            await self._index_queue.enqueue(content.user_id, content.id, revision)
        if settled is not None and settled.attachments:
            for record in await self._records.for_content(content.id):
                await self._ingestor.link_attachments(record, settled)
        logger.info(
            "parsed",
            extra={
                "contentId": content.id,
                "blocks": len(result.container.blocks),
                "engine": engine,
            },
        )

    async def _settle(
        self,
        content: Content,
        status: Status,
        *,
        stage: Stage | None = None,
        reason: str | None = None,
        **fields: Any,
    ) -> Content | None:
        """Sets the content's state and mirrors it onto every record holding it."""
        state = {"status": status, "stage": stage, "reason": reason}
        now = self._now()
        updated = await self._contents.update(content.id, now, **state, **fields)
        await self._records.update_for_content(content.id, now, **state)
        return updated
