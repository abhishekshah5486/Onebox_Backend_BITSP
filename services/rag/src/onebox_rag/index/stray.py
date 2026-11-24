"""Remove a content's points that its current revision no longer has.

Point ids follow the content, revision, block and text, so a retry writes the same points and
an old revision's are deleted once the new one is written. What can still be left behind is a
point the current revision does not have: written before a crash between the write and the
delete, or under text that changed (other split settings, another embedding input limit). This
pass lists the content's points and deletes those whose id is not in the revision's set.

It is a backstop, never the mechanism, so:
- it is idempotent: a second pass finds nothing;
- it is bounded: at most `max_points` points are listed per content per run, the rest by a
  later run (which resumes where this one stopped), and deletes go out in batches;
- a title point (its record's) or summary point (its classification's) is left to its owner;
- a failure is logged and never fails the content's indexing.
"""

import logging
from collections.abc import Iterable
from dataclasses import dataclass

from onebox_rag.index.points import PointKind
from onebox_rag.index.qdrant_store import QdrantStore

logger = logging.getLogger("onebox_rag.stray")

PAGE_SIZE = 500
DELETE_BATCH = 200
OWNED_ELSEWHERE = frozenset({PointKind.TITLE.value, PointKind.SUMMARY.value})


@dataclass(frozen=True)
class SweepResult:
    scanned: int = 0
    removed: int = 0
    # Where a pass that stopped at its bound ends; the next pass starts there.
    next_offset: str | None = None


async def sweep_stray_points(
    store: QdrantStore,
    collection: str,
    content_id: str,
    keep_ids: Iterable[str],
    *,
    max_points: int,
    resume: str | None = None,
) -> SweepResult:
    keep = set(keep_ids)
    strays: list[str] = []
    scanned = 0
    offset = resume
    stopped_at: str | None = None
    while True:
        page, next_offset = await store.list_points(
            collection, content_id, limit=min(PAGE_SIZE, max_points - scanned), offset=offset
        )
        for point_id, payload in page:
            scanned += 1
            if point_id not in keep and payload.get("kind") not in OWNED_ELSEWHERE:
                strays.append(point_id)
        if next_offset is None or next_offset == offset:
            break
        offset = next_offset
        if scanned >= max_points:
            stopped_at = offset
            break
    for start in range(0, len(strays), DELETE_BATCH):
        await store.delete_ids(collection, strays[start : start + DELETE_BATCH])
    if strays or stopped_at is not None:
        logger.info(
            "stray sweep",
            extra={
                "contentId": content_id,
                "scanned": scanned,
                "removed": len(strays),
                "resumesAt": stopped_at,
            },
        )
    return SweepResult(scanned, len(strays), stopped_at)
