import asyncio
import hashlib
import io
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, BinaryIO

from onebox_rag.errors import ConflictError
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.inspect import Inspection, Limits, inspect_file
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Content, Record, SourceType, Stage, Status
from onebox_rag.models.records import TERMINAL, DateOrigin, MailInfo
from onebox_rag.parsers.base import ExtractedFile

logger = logging.getLogger("onebox_rag.ingest")
_CHUNK = 1024 * 1024
# Content ids are derived from user and bytes, so the same file always lands on one content.
_CONTENT_NS = uuid.uuid5(uuid.NAMESPACE_URL, "https://onebox.dev/rag/contents")
# The digest of a file that was never fetched: it names the item, as there are no bytes.
UNREAD = "unread:"


def is_unread(record: Record) -> bool:
    return record.sha256.startswith(UNREAD)


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
    origin: DateOrigin = DateOrigin.SOURCE


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
        folder_id: str | None = None,
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
            folder_id=folder_id,
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
            stored=rejected is not None,
            created_at=now,
            updated_at=now,
        )
        content, created = await self._contents.claim(candidate)
        if created and content.blob_key is None:
            logger.info("file rejected", extra={"contentId": cid, "reason": content.reason})
            return content
        if content.blob_key is not None and not content.stored:
            # Ours to store, or left unstored by an attempt that failed: a failure here leaves
            # it unstored for the next attempt (the caller's retry) rather than deleting it.
            await self._blobs.put(content.blob_key, stream, content.mime_type)
            content = await self._contents.update(cid, self._now(), stored=True) or content
        if content.status == Status.QUEUED and content.stage == Stage.PARSE:
            # Queuing again is a no-op, and covers a crash between storing and queuing.
            await self._queue.enqueue(user_id, cid, content.revision)
        return content

    async def add_unread(
        self,
        *,
        user_id: str,
        source: Source,
        name: str,
        declared_mime_type: str | None,
        size_bytes: int,
        reason: str,
        external_id: str,
        parent_id: str | None = None,
        info: ItemInfo | None = None,
    ) -> Ingested:
        """A record for an item that wasn't fetched (too big, or its source couldn't send it):
        no bytes, failed with the reason, so it is listed rather than missing."""
        digest, now = f"{UNREAD}{source.type}/{source.id}/{external_id}", self._now()
        content, _ = await self._contents.claim(
            Content(
                id=content_id(user_id, digest),
                user_id=user_id,
                sha256=digest,
                mime_type=declared_mime_type or "application/octet-stream",
                size_bytes=size_bytes,
                blob_key=None,
                status=Status.FAILED,
                stage=None,
                reason=reason,
                stored=True,
                created_at=now,
                updated_at=now,
            )
        )
        return await self.add_record(
            user_id=user_id,
            source=source,
            content=content,
            name=name,
            declared_mime_type=declared_mime_type,
            external_id=external_id,
            parent_id=parent_id,
            info=info,
        )

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
        folder_id: str | None = None,
    ) -> Ingested:
        now = self._now()
        info = info or ItemInfo()
        created = info.created_at or now
        origin = info.origin if info.created_at else DateOrigin.UPLOAD
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
            date_origin=origin,
            folder_id=folder_id,
        )
        saved, inserted = await self._records.insert(record)
        if not inserted:
            if saved.deleted_at is not None:
                # Added again while in the trash: it comes back, where it was added this time.
                restored = await self._records.update(
                    saved.id, now, deleted_at=None, folder_id=folder_id
                )
                await self._records.set_children(
                    saved.id, now, deleted_at=None, folder_id=folder_id
                )
                return Ingested(restored or saved, duplicate=True)
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

    async def restore(
        self, record: Record, stream: BinaryIO, declared_mime_type: str | None
    ) -> Record:
        """Points a record at its bytes again: stored, and queued like a new upload's."""
        content = await self.store(record.user_id, stream, record.name, declared_mime_type)
        restored = await self._records.update(
            record.id,
            self._now(),
            content_id=content.id,
            sha256=content.sha256,
            mime_type=content.mime_type,
            size_bytes=content.size_bytes,
            status=content.status,
            stage=content.stage,
            reason=content.reason,
        )
        if content.id != record.content_id:
            await self._notify(content.id, [record.id], [])
        return restored or record

    async def requeue_stalled(self, before: datetime) -> int:
        """Queues contents left waiting with no live job; a live one makes it a no-op."""
        queued = 0
        for content in await self._contents.stalled(before):
            queue = self._queue if content.stage == Stage.PARSE else self._index_queue
            if queue is not None and content.stored:
                queued += await queue.enqueue(content.user_id, content.id, content.revision)
        return queued

    async def give_up(self, record: Record, reason: str) -> None:
        await self._records.update(
            record.id, self._now(), status=Status.FAILED, stage=None, reason=reason
        )

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
                folder_id=parent.folder_id,
            )

    async def reindex(
        self, user_id: str, record_ids: list[str]
    ) -> tuple[list[str], list[dict[str, Any]]]:
        """Reads the records' files again from the start, as a new revision. A record stays
        listed while that runs and is searchable again once the new revision is indexed."""
        queued: list[str] = []
        skipped: list[dict[str, Any]] = []
        # Per content: None once restarted, else why not (records sharing it share the answer).
        outcome: dict[str, str | None] = {}
        for record_id in dict.fromkeys(record_ids):
            record = await self._records.get(user_id, record_id)
            if record is None:
                skipped.append({"id": record_id, "reason": "Record not found"})
                continue
            cid = record.content_id
            if cid not in outcome:
                outcome[cid] = await self._restart(user_id, cid)
            reason = outcome[cid]
            if reason is None:
                queued.append(record_id)
            else:
                skipped.append({"id": record_id, "reason": reason})
        return queued, skipped

    async def _restart(self, user_id: str, cid: str) -> str | None:
        content = await self._contents.get(cid)
        if content is None or content.blob_key is None or not content.stored:
            return "Its file is not stored"
        if content.status not in TERMINAL:
            return "It is being read already"
        fresh = await self._contents.restart(content, self._now())
        if fresh is None:
            return "It is being read already"
        await self._records.update_for_content(
            cid, self._now(), status=Status.QUEUED, stage=Stage.PARSE, reason=None
        )
        await self._queue.enqueue(user_id, cid, fresh.revision)
        return None

    async def delete(self, user_id: str, record_id: str) -> bool:
        """Removes a record and its attachments' records; content nothing else holds goes too."""
        record = await self._records.get(user_id, record_id, trashed=None)
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

    async def replace(
        self,
        record: Record,
        stream: BinaryIO,
        declared_mime_type: str | None,
        modified_at: datetime | None = None,
    ) -> Record:
        """A new version of an uploaded file: the record keeps its id, name and place and reads
        the new bytes; the old content goes once nothing else holds it."""
        content = await self.store(record.user_id, stream, record.name, declared_mime_type)
        if content.id == record.content_id:
            return record
        holder = await self._records.by_external_id(
            record.user_id, record.source_type, record.source_id, content.sha256
        )
        if holder is not None and holder.id != record.id:
            await self.collect(content.id)
            raise ConflictError(f"That file is already in this collection as '{holder.name}'")
        now = self._now()
        old = record.content_id
        for child in await self._records.children(record.user_id, record.id):
            await self.delete(record.user_id, child.id)
        updated = await self._records.update(
            record.id,
            now,
            content_id=content.id,
            external_id=content.sha256,
            sha256=content.sha256,
            mime_type=content.mime_type,
            declared_mime_type=declared_mime_type,
            size_bytes=content.size_bytes,
            status=content.status,
            stage=content.stage,
            reason=content.reason,
            version=record.version + 1,
            titled=False,
            source_modified_at=modified_at or now,
        )
        saved = updated or record
        await self._notify(old, [], [record.id])
        await self.collect(old)
        latest = await self._contents.get(content.id)
        if latest is not None:
            # It may have been read meanwhile; the worker only updates records it saw.
            state = {"status": latest.status, "stage": latest.stage, "reason": latest.reason}
            if state != {"status": saved.status, "stage": saved.stage, "reason": saved.reason}:
                saved = await self._records.update(saved.id, self._now(), **state) or saved
            await self.link_attachments(saved, latest)
        await self._notify(content.id, [saved.id], [])
        return saved

    async def renamed(self, record: Record) -> None:
        """Writes its title point again, now (the sweep would, later)."""
        await self._notify(record.content_id, [record.id], [])

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
