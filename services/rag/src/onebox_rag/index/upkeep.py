"""Keeps a content's points in step with the records holding it: the records' dates on every
point (what date filters read), and a header point per email record."""

import asyncio
import logging
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime

from onebox_rag.index.embed import DenseEmbedder, sparse_documents
from onebox_rag.index.headers import header_text
from onebox_rag.index.points import POINT_NAMESPACE, PointKind
from onebox_rag.index.qdrant_store import (
    CREATED,
    MODIFIED,
    QdrantStore,
    StoredPoint,
    collection_name,
)
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Content, Record, Status

logger = logging.getLogger("onebox_rag.index")


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

    async def sync(self, content_id: str, removed: Iterable[str] = ()) -> None:
        """After records holding the content were added, changed or `removed`."""
        content = await self._contents.get(content_id)
        if content is None or content.status != Status.COMPLETED or not content.index_collection:
            return  # not indexed yet: the index step syncs it when it is
        holders = await self._records.for_content(content_id)
        collection = content.index_collection
        await self._store.set_dates(
            collection,
            content_id,
            sorted({_iso(r.dates()[0]) for r in holders}),
            sorted({_iso(r.dates()[1]) for r in holders}),
        )
        emails = [r for r in holders if r.mail is not None]
        stale = [r.id for r in emails] + list(removed)
        if stale:
            points = await self._headers(content, collection, emails)
            await self._store.replace_headers(collection, content_id, stale, points)
        await self._contents.update(content_id, self._now(), points_dated=True)

    async def sync_undated(self) -> int:
        """Contents indexed before their points carried dates (or whose sync failed)."""
        done = 0
        for content_id in await self._contents.undated():
            try:
                await self.sync(content_id)
                done += 1
            except Exception:
                logger.warning(
                    "point dates not synced", extra={"contentId": content_id}, exc_info=True
                )
        return done

    async def _headers(
        self, content: Content, collection: str, emails: list[Record]
    ) -> list[StoredPoint]:
        model = await self._dense.model_for(content.user_id)
        if not emails or collection_name(model) != collection:
            return []  # the model changed: a re-index writes them in the new collection
        texts = [header_text(r) for r in emails]
        dense, sparse = await asyncio.gather(
            self._dense.embed(content.user_id, model, texts),
            asyncio.to_thread(sparse_documents, texts),
        )
        points = []
        for record, text, vector, terms in zip(emails, texts, dense, sparse, strict=True):
            created, modified = record.dates()
            name = f"{content.id}|{content.revision}|header|{record.id}|{text}"
            points.append(
                StoredPoint(
                    id=str(uuid.uuid5(POINT_NAMESPACE, name)),
                    dense=vector,
                    sparse=terms,
                    payload={
                        "userId": content.user_id,
                        "contentId": content.id,
                        "recordId": record.id,
                        "revision": content.revision,
                        "kind": PointKind.HEADER.value,
                        "blockIndex": None,
                        "groupIndex": None,
                        "text": text,
                        CREATED: [_iso(created)],
                        MODIFIED: [_iso(modified)],
                    },
                )
            )
        return points
