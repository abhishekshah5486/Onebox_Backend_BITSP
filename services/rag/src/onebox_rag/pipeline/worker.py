import logging
from typing import Any, Protocol

from bullmq import Worker

from onebox_rag.config import Settings

logger = logging.getLogger("onebox_rag.worker")


class Stage(Protocol):
    async def run(self, content_id: str, revision: int, *, final_attempt: bool) -> None: ...


def stage_worker(settings: Settings, queue: str, stage: Stage, concurrency: int) -> Worker:
    """Consumes a stage's queue. A failed attempt is retried with backoff until the last one,
    which marks the content failed instead of raising again."""

    async def process(job: Any, _token: str) -> None:
        payload = job.data["payload"]
        attempts = int(job.opts.get("attempts", 1))
        await stage.run(
            payload["contentId"],
            int(payload["revision"]),
            final_attempt=job.attemptsMade + 1 >= attempts,
        )

    return Worker(queue, process, {"connection": settings.REDIS_URL, "concurrency": concurrency})


def parse_worker(settings: Settings, stage: Stage) -> Worker:
    return stage_worker(settings, settings.RAG_INGEST_QUEUE, stage, settings.RAG_PARSE_WORKERS)
