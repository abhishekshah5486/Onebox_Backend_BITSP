import asyncio
import gzip
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import TERMINAL, Attachment, Content, Stage, Status
from onebox_rag.models.blocks import BlocksContainer
from onebox_rag.parsers.base import ParseResult, UnreadableFileError
from onebox_rag.parsers.registry import parser_for

logger = logging.getLogger("onebox_rag.parse")


def encode_blocks(container: BlocksContainer) -> bytes:
    return gzip.compress(container.model_dump_json(by_alias=True, exclude_none=True).encode())


def decode_blocks(data: bytes) -> BlocksContainer:
    return BlocksContainer.model_validate_json(gzip.decompress(data))


class ParseStage:
    """Step 3: parse a content into blocks, store them, and move every record holding it on."""

    def __init__(
        self,
        contents: ContentStore,
        records: RecordStore,
        blobs: BlobStore,
        ingestor: Ingestor,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._contents, self._records, self._blobs = contents, records, blobs
        self._ingestor, self._now = ingestor, now

    async def run(self, content_id: str, revision: int, *, final_attempt: bool) -> None:
        content = await self._contents.get(content_id)
        # Deleted, superseded by a newer revision, or already done: nothing to do.
        if (
            content is None
            or content.revision != revision
            or content.status in TERMINAL
            or content.stage != Stage.PARSE
        ):
            return
        parser = parser_for(content.mime_type)
        if parser is None or content.blob_key is None:
            reason = f"{content.mime_type} can't be read yet"
            await self._settle(content, Status.FILE_TYPE_NOT_SUPPORTED, reason=reason)
            return
        await self._settle(content, Status.IN_PROGRESS, stage=Stage.PARSE, engine=parser.engine)
        data = await self._blobs.get(content.blob_key)
        try:
            result: ParseResult = await asyncio.to_thread(parser.parse, data)
            problems = result.container.problems()
            if problems:
                raise ValueError(f"{parser.engine} built a broken container: {problems[:3]}")
        except UnreadableFileError as err:
            await self._settle(content, Status.FAILED, reason=str(err) or "unreadable")
            return
        except Exception:
            logger.exception(
                "parse failed", extra={"contentId": content_id, "final": final_attempt}
            )
            if final_attempt:
                await self._settle(content, Status.FAILED, reason="could not be parsed")
            else:
                # Back to queued, so the retry passes the checks above.
                await self._settle(content, Status.QUEUED, stage=Stage.PARSE)
            raise

        attachments = [
            Attachment(
                name=file.name,
                mime_type=(
                    child := await self._ingestor.store_extracted(content.user_id, file)
                ).mime_type,
                content_id=child.id,
            )
            for file in result.attachments
        ]
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
                "engine": parser.engine,
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
