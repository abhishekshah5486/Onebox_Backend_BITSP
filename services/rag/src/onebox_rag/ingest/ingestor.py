import asyncio
import hashlib
import io
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import BinaryIO

from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.inspect import Inspection, Limits, inspect_file
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Content, Record, SourceType, Stage, Status
from onebox_rag.parsers.base import ExtractedFile

logger = logging.getLogger("onebox_rag.ingest")
_CHUNK = 1024 * 1024
# Content ids are derived from user and bytes, so the same file always lands on one content.
_CONTENT_NS = uuid.uuid5(uuid.NAMESPACE_URL, "https://onebox.dev/rag/contents")


@dataclass(frozen=True)
class Ingested:
    record: Record
    duplicate: bool


@dataclass(frozen=True)
class Source:
    type: SourceType
    id: str


def content_id(user_id: str, sha256: str) -> str:
    return str(uuid.uuid5(_CONTENT_NS, f"{user_id}/{sha256}"))


def _digest(stream: BinaryIO) -> tuple[str, int]:
    stream.seek(0)
    sha, size = hashlib.sha256(), 0
    while chunk := stream.read(_CHUNK):
        sha.update(chunk)
        size += len(chunk)
    stream.seek(0)
    return sha.hexdigest(), size


class Ingestor:
    """Step 1: check a file, store its bytes once per user, and give it a record in its source.

    Identical bytes share one content (PipesHub's virtual record), so an attachment sent in ten
    emails is stored, parsed and indexed once and its ten records follow that one outcome."""

    def __init__(
        self,
        records: RecordStore,
        contents: ContentStore,
        blobs: BlobStore,
        queue: IngestQueue,
        limits: Limits,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._records, self._contents, self._blobs, self._queue = records, contents, blobs, queue
        self._limits, self._now = limits, now

    async def ingest(
        self,
        *,
        user_id: str,
        source: Source,
        name: str,
        declared_mime_type: str | None,
        stream: BinaryIO,
        external_id: str | None = None,
        parent_id: str | None = None,
    ) -> Ingested:
        content = await self.store(user_id, stream, name, declared_mime_type)
        return await self.add_record(
            user_id=user_id,
            source=source,
            content=content,
            name=name,
            declared_mime_type=declared_mime_type,
            external_id=external_id or content.sha256,
            parent_id=parent_id,
        )

    async def store_extracted(self, user_id: str, file: ExtractedFile) -> Content:
        return await self.store(user_id, io.BytesIO(file.data), file.name, file.mime_type)

    async def store(
        self, user_id: str, stream: BinaryIO, name: str, declared_mime_type: str | None
    ) -> Content:
        """The content for these bytes: existing, or checked, stored and queued for parsing."""

        def examine() -> tuple[str, int, Inspection]:
            sha, size = _digest(stream)
            return sha, size, inspect_file(stream, size, name, declared_mime_type, self._limits)

        # Hashing and inspecting can take a while on big files; keep the event loop free.
        sha, size, found = await asyncio.to_thread(examine)
        cid, now, rejected = content_id(user_id, sha), self._now(), found.rejection
        candidate = Content(
            id=cid,
            user_id=user_id,
            sha256=sha,
            mime_type=found.mime_type,
            size_bytes=size,
            blob_key=None if rejected else f"{user_id}/contents/{cid}/original",
            status=rejected.status if rejected else Status.QUEUED,
            stage=None if rejected else Stage.PARSE,
            reason=rejected.reason if rejected else None,
            created_at=now,
            updated_at=now,
        )
        content, created = await self._contents.claim(candidate)
        if created and content.blob_key:
            try:
                await self._blobs.put(content.blob_key, stream, content.mime_type)
                await self._queue.enqueue(user_id, cid, content.revision)
            except Exception:
                # Forget it, so the next attempt with these bytes starts clean.
                await self._contents.delete(cid)
                raise
        elif created:
            logger.info("file rejected", extra={"contentId": cid, "reason": content.reason})
        elif content.status == Status.QUEUED and content.stage == Stage.PARSE:
            # A crash may have stopped it between storing and queuing; queuing again is a no-op.
            await self._queue.enqueue(user_id, cid, content.revision)
        return content

    async def add_record(
        self,
        *,
        user_id: str,
        source: Source,
        content: Content,
        name: str,
        declared_mime_type: str | None,
        external_id: str,
        parent_id: str | None = None,
    ) -> Ingested:
        now = self._now()
        record = Record(
            id=str(uuid.uuid4()),
            user_id=user_id,
            source_type=source.type,
            source_id=source.id,
            external_id=external_id,
            parent_id=parent_id,
            content_id=content.id,
            name=name,
            declared_mime_type=declared_mime_type,
            mime_type=content.mime_type,
            size_bytes=content.size_bytes,
            sha256=content.sha256,
            status=content.status,
            stage=content.stage,
            reason=content.reason,
            created_at=now,
            updated_at=now,
        )
        saved, created = await self._records.insert(record)
        if not created:
            return Ingested(saved, duplicate=True)
        # The parse may have finished between reading the content and saving this record;
        # the worker only updates records that existed when it finished.
        latest = await self._contents.get(content.id)
        if latest is not None:
            state = {"status": latest.status, "stage": latest.stage, "reason": latest.reason}
            if state != {"status": saved.status, "stage": saved.stage, "reason": saved.reason}:
                saved = await self._records.update(saved.id, self._now(), **state) or saved
            await self.link_attachments(saved, latest)
        return Ingested(saved, duplicate=False)

    async def link_attachments(self, parent: Record, content: Content) -> None:
        """Gives a record one child record per file inside its content (an email's attachments)."""
        for number, attachment in enumerate(content.attachments, start=1):
            child = await self._contents.get(attachment.content_id)
            if child is None:
                continue
            await self.add_record(
                user_id=parent.user_id,
                source=Source(parent.source_type, parent.source_id),
                content=child,
                name=attachment.name,
                declared_mime_type=attachment.mime_type,
                external_id=f"{parent.external_id}/attachments/{number}",
                parent_id=parent.id,
            )

    async def delete(self, user_id: str, record_id: str) -> bool:
        """Removes a record and its attachments' records; content nothing else holds goes too."""
        record = await self._records.get(user_id, record_id)
        if record is None:
            return False
        doomed, pending = [], [record]
        while pending:
            item = pending.pop()
            doomed.append(item)
            pending += await self._records.children(user_id, item.id)
        await self._records.delete([item.id for item in doomed])
        for cid in dict.fromkeys(item.content_id for item in doomed):
            await self.collect(cid)
        return True

    async def collect(self, cid: str) -> None:
        """Deletes a content, its stored files and pending job once no record holds it."""
        if await self._records.holds_content(cid):
            return
        content = await self._contents.get(cid)
        if content is None:
            return
        await self._queue.remove(cid, content.revision)
        for key in (content.blob_key, content.blocks_key):
            if key:
                await self._blobs.delete(key)
        await self._contents.delete(cid)
        for attachment in content.attachments:
            await self.collect(attachment.content_id)
