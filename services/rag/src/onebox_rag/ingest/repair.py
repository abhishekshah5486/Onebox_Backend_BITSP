"""Records left waiting on a content that no longer exists: an older failed store deleted the
content while another job had already given it a record. An email (or its attachment) is read
again from the mailbox; an upload's bytes are gone, so it fails and asks to be uploaded again."""

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime

from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.records import RecordStore
from onebox_rag.models import Record, SourceType

logger = logging.getLogger("onebox_rag.repair")

LOST_UPLOAD = "The file was not stored; upload it again"
LOST_EMAIL = "The email is no longer in the mailbox"


async def repair_orphans(
    records: RecordStore,
    ingestor: Ingestor,
    refetch: Callable[[Record], Awaitable[bool]] | None,
    *,
    limit: int = 100,
) -> int:
    """Repairs up to `limit` orphaned records; each is handled on its own, so one failing (the
    mailbox down) leaves it for the next sweep and never stops the others."""
    repaired = 0
    for record in await records.orphans(limit):
        try:
            if record.source_type == SourceType.MAIL and refetch is not None:
                if not await refetch(record):
                    await ingestor.give_up(record, LOST_EMAIL)
            elif record.source_type != SourceType.MAIL:
                await ingestor.give_up(record, LOST_UPLOAD)
            else:
                continue  # mail is not read by this process; another one repairs it
            repaired += 1
        except Exception:
            logger.warning("repair failed", extra={"recordId": record.id}, exc_info=True)
    if repaired:
        logger.info("orphaned records repaired", extra={"count": repaired})
    return repaired


async def requeue_stalled(ingestor: Ingestor, before: datetime) -> int:
    queued = await ingestor.requeue_stalled(before)
    if queued:
        logger.info("stalled contents queued again", extra={"count": queued})
    return queued
