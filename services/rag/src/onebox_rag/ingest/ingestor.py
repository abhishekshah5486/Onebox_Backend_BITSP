import asyncio
import hashlib
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import BinaryIO

from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.inspect import Limits, inspect_file
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import RecordStore
from onebox_rag.models import Record, RecordStatus, SourceType

logger = logging.getLogger("onebox_rag.ingest")
_CHUNK = 1024 * 1024


@dataclass(frozen=True)
class Ingested:
    record: Record
    duplicate: bool


def _digest(stream: BinaryIO) -> tuple[str, int]:
    stream.seek(0)
    sha, size = hashlib.sha256(), 0
    while chunk := stream.read(_CHUNK):
        sha.update(chunk)
        size += len(chunk)
    stream.seek(0)
    return sha.hexdigest(), size


class Ingestor:
    """Step 1 of the pipeline: check the file, store the original, save the record, queue it."""

    def __init__(
        self,
        records: RecordStore,
        blobs: BlobStore,
        queue: IngestQueue,
        limits: Limits,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._records, self._blobs, self._queue = records, blobs, queue
        self._limits, self._now = limits, now

    async def ingest(
        self,
        *,
        user_id: str,
        source_type: SourceType,
        source_id: str,
        name: str,
        declared_mime_type: str | None,
        stream: BinaryIO,
        external_id: str | None = None,
        parent_id: str | None = None,
    ) -> Ingested:
        def examine() -> tuple[str, int, str, str | None]:
            sha, size = _digest(stream)
            found = inspect_file(stream, size, name, declared_mime_type, self._limits)
            return sha, size, found.mime_type, found.rejection

        # Hashing and inspecting can take a while on big files; keep the event loop free.
        sha, size, mime, rejection = await asyncio.to_thread(examine)
        record_id, now = str(uuid.uuid4()), self._now()
        record = Record(
            id=record_id,
            user_id=user_id,
            source_type=source_type,
            source_id=source_id,
            external_id=external_id or sha,
            parent_id=parent_id,
            name=name,
            declared_mime_type=declared_mime_type,
            mime_type=mime,
            size_bytes=size,
            sha256=sha,
            blob_key=None if rejection else f"{user_id}/{record_id}/1",
            status=RecordStatus.REJECTED if rejection else RecordStatus.QUEUED,
            reason=rejection,
            created_at=now,
            updated_at=now,
        )
        saved, created = await self._records.insert(record)
        if not created:
            # A crash may have stopped it between saving and queuing; queuing again is a no-op.
            if saved.status == RecordStatus.QUEUED:
                await self._queue.enqueue(user_id, saved.id, saved.revision)
            return Ingested(saved, duplicate=True)
        if saved.blob_key is None:
            logger.info("file rejected", extra={"recordId": saved.id, "reason": rejection})
            return Ingested(saved, duplicate=False)
        try:
            await self._blobs.put(saved.blob_key, stream, mime)
            await self._queue.enqueue(user_id, saved.id, saved.revision)
        except Exception:
            await self._records.set_status(
                saved.id, self._now(), status=RecordStatus.FAILED, reason="could not be stored"
            )
            raise
        return Ingested(saved, duplicate=False)

    async def delete(self, user_id: str, record_id: str) -> bool:
        """Removes a record, its attachments' records, their originals and pending jobs."""
        record = await self._records.get(user_id, record_id)
        if record is None:
            return False
        doomed = [record, *await self._records.children(user_id, record_id)]
        for item in doomed:
            await self._queue.remove(item.id, item.revision)
            if item.blob_key:
                await self._blobs.delete(item.blob_key)
        await self._records.delete([item.id for item in doomed])
        return True
