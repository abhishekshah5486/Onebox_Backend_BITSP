import logging
from typing import Any

from bullmq import Worker

from onebox_rag.config import Settings
from onebox_rag.pipeline.parse import ParseStage

logger = logging.getLogger("onebox_rag.worker")


def parse_worker(settings: Settings, stage: ParseStage) -> Worker:
    """Consumes rag-ingest. A failed attempt is retried with backoff until the last one, which
    marks the content failed instead of raising again."""

    async def process(job: Any, _token: str) -> None:
        payload = job.data["payload"]
        attempts = int(job.opts.get("attempts", 1))
        await stage.run(
            payload["contentId"],
            int(payload["revision"]),
            final_attempt=job.attemptsMade + 1 >= attempts,
        )

    return Worker(
        settings.RAG_INGEST_QUEUE,
        process,
        {"connection": settings.REDIS_URL, "concurrency": settings.RAG_PARSE_CONCURRENCY},
    )
