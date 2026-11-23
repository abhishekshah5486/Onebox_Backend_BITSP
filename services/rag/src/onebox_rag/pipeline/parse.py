import dataclasses
import gzip
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import TERMINAL, Attachment, Content, Stage, Status
from onebox_rag.models.blocks import BlocksContainer
from onebox_rag.parsers.base import ParseResult, UnreadableFileError
from onebox_rag.parsers.pdf.inspection import PdfFacts, inspect_pdf
from onebox_rag.parsers.registry import parser_for
from onebox_rag.pipeline.pool import ParsePool, ParseWorkerError
from onebox_rag.pipeline.routing import PDF, PdfLimits, Route, parser_for_engine, route_pdf

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
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._contents, self._records, self._blobs = contents, records, blobs
        self._ingestor, self._pool, self._pdf, self._now = ingestor, pool, pdf, now

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
        parser = parser_for_engine(content.mime_type, route.engine)
        if parser is None:
            reason = f"waiting for the {route.engine} engine"
            await self._settle(content, Status.FILE_TYPE_NOT_SUPPORTED, reason=reason)
            return
        await self._settle(content, Status.IN_PROGRESS, stage=Stage.PARSE)
        label = f"content {content.id}"
        try:
            result: ParseResult = await self._pool.run(parser.parse, data, label=label)
            problems = result.container.problems()
            if problems:
                raise ValueError(f"{parser.engine} built a broken container: {problems[:3]}")
        except UnreadableFileError as err:
            await self._settle(content, Status.FAILED, reason=str(err) or "unreadable")
            return
        except ParseWorkerError as err:
            await self._worker_failed(content, err, final_attempt)
            raise
        except Exception:
            logger.exception(
                "parse failed", extra={"contentId": content_id, "final": final_attempt}
            )
            await self._retry_or_fail(content, final_attempt, "could not be parsed")
            raise
        await self._store(content, revision, result, parser.engine)

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
                # Best effort, as in PipesHub: without facts the size decides.
                logger.warning(
                    "pdf inspection failed", extra={"contentId": content.id}, exc_info=True
                )
            route = route_pdf(facts, content.size_bytes, self._pdf.limits)
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
