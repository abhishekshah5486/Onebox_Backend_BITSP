import asyncio
import hashlib
import io
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import BinaryIO

from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.inspect import Inspection, Limits, inspect_file
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Content, Record, SourceType, Stage, Status
from onebox_rag.models.records import MailInfo
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


@dataclass(frozen=True)
class ItemInfo:
    """What the source knows of an item: when it was written and last changed (default: when
    it arrived here), and an email's details."""

    created_at: datetime | None = None
    modified_at: datetime | None = None
    mail: MailInfo | None = None


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

    Identical bytes share one content (a virtual record), so an attachment sent in ten
    emails is stored, parsed and indexed once and its ten records follow that one outcome."""

    def __init__(
        self,
        records: RecordStore,
        contents: ContentStore,
        blobs: BlobStore,
        queue: IngestQueue,
        limits: Limits,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        index_queue: IngestQueue | None = None,
        forget: Callable[[Content], Awaitable[None]] | None = None,
        changed: Callable[[str, list[str], list[str]], Awaitable[None]] | None = None,
    ) -> None:
        self._records, self._contents, self._blobs, self._queue = records, contents, blobs, queue
        self._limits, self._now = limits, now
        # Index jobs and indexed points of content that is deleted.
        self._index_queue, self._forget = index_queue, forget
        # Told (content, added record ids, removed record ids) when a content's records change.
        self._changed = changed

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
        info: ItemInfo | None = None,
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
            info=info,
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
        info: ItemInfo | None = None,
    ) -> Ingested:
        now = self._now()
        info = info or ItemInfo()
        created = info.created_at or now
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
            mail=info.mail,
            source_created_at=created,
            source_modified_at=info.modified_at or created,
        )
        saved, inserted = await self._records.insert(record)
        if not inserted:
            return Ingested(saved, duplicate=True)
        # The parse may have finished between reading the content and saving this record;
        # the worker only updates records that existed when it finished.
        latest = await self._contents.get(content.id)
        if latest is not None:
            state = {"status": latest.status, "stage": latest.stage, "reason": latest.reason}
            if state != {"status": saved.status, "stage": saved.stage, "reason": saved.reason}:
                saved = await self._records.update(saved.id, self._now(), **state) or saved
            await self.link_attachments(saved, latest)
        await self._notify(content.id, [saved.id], [])
        return Ingested(saved, duplicate=False)

    async def link_attachments(self, parent: Record, content: Content) -> None:
        """Gives a record one child record per file inside its content (an email's attachments)."""
        created, modified = parent.dates()
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
                info=ItemInfo(created, modified),
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
            # Their title points go first; the content goes too once nothing holds it.
            await self._notify(cid, [], [item.id for item in doomed if item.content_id == cid])
            await self.collect(cid)
        return True

    async def _notify(self, content_id: str, added: list[str], removed: list[str]) -> None:
        if self._changed is None:
            return
        try:
            await self._changed(content_id, added, removed)
        except Exception:
            # The record change stands; the points catch up on the next sweep.
            logger.warning("point upkeep failed", extra={"contentId": content_id}, exc_info=True)
            await self._contents.update(content_id, self._now(), points_dated=False)

    async def collect(self, cid: str) -> None:
        """Deletes a content, its stored files and pending job once no record holds it."""
        if await self._records.holds_content(cid):
            return
        content = await self._contents.get(cid)
        if content is None:
            return
        await self._queue.remove(cid, content.revision)
        if self._index_queue is not None:
            await self._index_queue.remove(cid, content.revision)
        if self._forget is not None:
            await self._forget(content)
        for key in (content.blob_key, content.blocks_key):
            if key:
                await self._blobs.delete(key)
        await self._contents.delete(cid)
        for attachment in content.attachments:
            await self.collect(attachment.content_id)
