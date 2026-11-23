import uuid
from datetime import UTC, datetime
from typing import Any

from bullmq import Queue

from onebox_rag.config import Settings

# Same envelope as packages/contracts' job envelope, so TypeScript producers can feed this queue.
JOB_SCHEMA_VERSION = 1


def job_id(record_id: str, revision: int) -> str:
    # BullMQ refuses ids with ':' (its key separator).
    return f"{record_id}_{revision}"


class IngestQueue:
    """Parse jobs, one per record revision; enqueuing the same revision twice is a no-op."""

    def __init__(self, settings: Settings) -> None:
        self.name = settings.RAG_INGEST_QUEUE
        self._queue = Queue(self.name, {"connection": settings.REDIS_URL})
        self._opts = {
            "attempts": settings.RAG_INGEST_ATTEMPTS,
            "backoff": {"type": "exponential", "delay": settings.RAG_INGEST_BACKOFF_MS},
            "removeOnComplete": {"age": 3600, "count": 5000},
            "removeOnFail": {"age": 7 * 24 * 3600},
        }

    async def enqueue(self, user_id: str, record_id: str, revision: int) -> bool:
        """True when queued, False when that revision was already queued."""
        jid = job_id(record_id, revision)
        if await self._queue.getJob(jid) is not None:
            return False
        envelope: dict[str, Any] = {
            "jobId": jid,
            "userId": user_id,
            "traceId": str(uuid.uuid4()),
            "attempt": 1,
            "enqueuedAt": datetime.now(UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "schemaVersion": JOB_SCHEMA_VERSION,
            "payload": {"recordId": record_id, "revision": revision},
        }
        await self._queue.add(self.name, envelope, {**self._opts, "jobId": jid})
        return True

    async def job_data(self, record_id: str, revision: int) -> dict[str, Any] | None:
        job = await self._queue.getJob(job_id(record_id, revision))
        return dict(job.data) if job is not None else None

    async def remove(self, record_id: str, revision: int) -> None:
        job = await self._queue.getJob(job_id(record_id, revision))
        if job is not None:
            await job.remove()

    async def close(self) -> None:
        await self._queue.close()
