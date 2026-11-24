"""Keeps points in step with the records they belong to: a title point per record, written as
soon as the record is made (so it is found by name before its content is parsed), and the
records' dates on their content's points (what date filters read)."""

import asyncio
import logging
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime

from onebox_rag.index.embed import DenseEmbedder, SparseVector, sparse_documents
from onebox_rag.index.points import POINT_NAMESPACE, PointKind
from onebox_rag.index.qdrant_store import CREATED, MODIFIED, UPLOADED, QdrantStore, StoredPoint
from onebox_rag.index.titles import title_label, title_text
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Record, Status
from onebox_rag.models.records import DateOrigin

logger = logging.getLogger("onebox_rag.index")
TITLE_BATCH = 64


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


class PointUpkeep:
    def __init__(
        self,
        contents: ContentStore,
        records: RecordStore,
        store: QdrantStore,
        dense: DenseEmbedder,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._contents, self._records, self._store, self._dense = contents, records, store, dense
        self._now = now

    async def sync(
        self,
        content_id: str,
        added: Iterable[str] = (),
        removed: Iterable[str] = (),
        *,
        retitle: bool = False,
    ) -> None:
        """After records holding the content were `added` or `removed` (by id); `retitle`
        writes every holder's title again (its user's embedding model changed)."""
        content = await self._contents.get(content_id)
        if content is None:
            return
        holders = await self._records.for_content(content_id)
        fresh = set(added)
        await self.write_titles(
            content.user_id, [r for r in holders if retitle or r.id in fresh], list(removed)
        )
        if content.status != Status.COMPLETED or not content.index_collection:
            return  # not indexed yet: the index step syncs it when it is
        await self._store.set_dates(
            content.index_collection,
            content_id,
            sorted({_iso(r.dates()[0]) for r in holders}),
            sorted({_iso(r.dates()[1]) for r in holders}),
            sorted({_iso(r.dates()[0]) for r in holders if r.date_origin == DateOrigin.UPLOAD}),
        )
        await self._contents.update(content_id, self._now(), points_dated=True)

    async def write_titles(
        self, user_id: str, records: list[Record], removed: list[str] | None = None
    ) -> None:
        """Each record's title point, replacing any it had; `removed` records lose theirs."""
        stale = [r.id for r in records] + list(removed or [])
        if not stale:
            return
        model = await self._dense.model_for(user_id)
        collection = await self._store.ensure_collection(model)
        points: list[StoredPoint] = []
        if records:
            texts = [title_text(r) for r in records]
            dense, sparse = await asyncio.gather(
                self._dense.embed(user_id, model, texts),
                asyncio.to_thread(sparse_documents, texts),
            )
            points = [
                _title_point(record, text, vector, terms)
                for record, text, vector, terms in zip(records, texts, dense, sparse, strict=True)
            ]
        await self._store.replace_titles(collection, stale, points)
        now = self._now()
        for record in records:
            await self._records.update(record.id, now, titled=True)

    async def sweep(self) -> int:
        """Records without a title point and contents whose points lack their records' dates:
        made before these existed, or their upkeep failed."""
        done = 0
        by_user: dict[str, list[Record]] = {}
        for record in await self._records.untitled():
            by_user.setdefault(record.user_id, []).append(record)
        for user_id, records in by_user.items():
            for start in range(0, len(records), TITLE_BATCH):
                batch = records[start : start + TITLE_BATCH]
                try:
                    await self.write_titles(user_id, batch)
                    done += len(batch)
                except Exception:
                    logger.warning("titles not written", extra={"userId": user_id}, exc_info=True)
        for content_id in await self._contents.undated():
            try:
                await self.sync(content_id)
                done += 1
            except Exception:
                logger.warning(
                    "point dates not synced", extra={"contentId": content_id}, exc_info=True
                )
        return done


def _title_point(
    record: Record, text: str, vector: list[float], terms: SparseVector
) -> StoredPoint:
    created, modified = record.dates()
    return StoredPoint(
        id=str(uuid.uuid5(POINT_NAMESPACE, f"title|{record.id}|{text}")),
        dense=vector,
        sparse=terms,
        payload={
            "userId": record.user_id,
            "contentId": record.content_id,
            "recordId": record.id,
            "kind": PointKind.TITLE.value,
            "blockIndex": None,
            "groupIndex": None,
            "text": text,
            "label": title_label(record),
            CREATED: [_iso(created)],
            MODIFIED: [_iso(modified)],
            UPLOADED: [_iso(created)] if record.date_origin == DateOrigin.UPLOAD else [],
        },
    )
