import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from onebox_rag.index.embed import DenseEmbedder, EmbeddingUnavailableError, sparse_documents
from onebox_rag.index.points import PointText, SplitSettings, point_texts
from onebox_rag.index.qdrant_store import QdrantStore, StoredPoint
from onebox_rag.index.tokens import TokenLimitError
from onebox_rag.index.upkeep import PointUpkeep
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import TERMINAL, Content, Stage, Status
from onebox_rag.pipeline.parse import decode_blocks

logger = logging.getLogger("onebox_rag.index")


class IndexStage:
    """Step 6: a parsed content's blocks become points (dense and sparse vectors) in its user's
    collection. The new revision's points are written before the old ones are deleted, so a
    search always finds one of them."""

    def __init__(
        self,
        contents: ContentStore,
        records: RecordStore,
        blobs: BlobStore,
        dense: DenseEmbedder,
        store: QdrantStore,
        split: SplitSettings,
        upkeep: PointUpkeep | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._contents, self._records, self._blobs = contents, records, blobs
        self._upkeep = upkeep
        self._dense, self._store, self._split, self._now = dense, store, split, now

    async def run(self, content_id: str, revision: int, *, final_attempt: bool) -> None:
        content = await self._contents.get(content_id)
        if (
            content is None
            or content.revision != revision
            or content.status in TERMINAL
            or content.stage != Stage.INDEX
            or content.blocks_key is None
        ):
            return
        await self._settle(content, Status.IN_PROGRESS, stage=Stage.INDEX)
        moved = False
        try:
            container = decode_blocks(await self._blobs.get(content.blocks_key))
            model = await self._dense.model_for(content.user_id)
            window = self._split.window_for(model.id, model.context_tokens)
            texts = await asyncio.to_thread(point_texts, container, self._split, window)
            collection = await self._store.ensure_collection(model)
            points = await self._points(content, model, texts)
            await self._store.upsert(collection, points)
            await self._store.delete_content(collection, content.id, keep_revision=revision)
            if content.index_collection and content.index_collection != collection:
                # Indexed before with another embedding model: its records' titles move too.
                await self._store.delete_content(content.index_collection, content.id)
                moved = True
        except TokenLimitError as err:
            # Every try would fail the same way until the user picks another model.
            logger.warning("embedding input too small", extra={"contentId": content_id})
            await self._settle(content, Status.FAILED, stage=Stage.INDEX, reason=str(err))
            return
        except EmbeddingUnavailableError as err:
            logger.warning(
                "embedding unavailable", extra={"contentId": content_id, "why": str(err)}
            )
            await self._retry_or_fail(content, final_attempt, "the embedding model is unavailable")
            raise
        except Exception:
            logger.exception("index failed", extra={"contentId": content_id})
            await self._retry_or_fail(content, final_attempt, "could not be indexed")
            raise
        await self._settle(
            content,
            Status.COMPLETED,
            index_collection=collection,
            embedding_model=model.id,
            point_count=len(points),
            points_dated=False,
        )
        if self._upkeep is not None:
            try:
                await self._upkeep.sync(content_id, retitle=moved)
            except Exception:
                # Searchable already; its dates and header points follow on the next sweep.
                logger.warning(
                    "point upkeep failed", extra={"contentId": content_id}, exc_info=True
                )
        logger.info(
            "indexed",
            extra={"contentId": content_id, "points": len(points), "collection": collection},
        )

    async def _points(
        self, content: Content, model: Any, texts: list[PointText]
    ) -> list[StoredPoint]:
        if not texts:
            return []
        strings = [t.text for t in texts]
        dense, sparse = await asyncio.gather(
            self._dense.embed(content.user_id, model, strings),
            asyncio.to_thread(sparse_documents, strings),
        )
        return [
            StoredPoint(
                id=t.point_id(content.id, content.revision),
                dense=vector,
                sparse=terms,
                payload={
                    "userId": content.user_id,
                    "contentId": content.id,
                    "revision": content.revision,
                    "kind": t.kind.value,
                    "blockIndex": t.block_index,
                    "groupIndex": t.group_index,
                    "text": t.text,
                    **t.payload,
                },
            )
            for t, vector, terms in zip(texts, dense, sparse, strict=True)
        ]

    async def _retry_or_fail(self, content: Content, final: bool, reason: str) -> None:
        if final:
            await self._settle(content, Status.FAILED, stage=Stage.INDEX, reason=reason)
        else:
            await self._settle(content, Status.QUEUED, stage=Stage.INDEX)

    async def _settle(
        self,
        content: Content,
        status: Status,
        *,
        stage: Stage | None = None,
        reason: str | None = None,
        **fields: Any,
    ) -> None:
        state = {"status": status, "stage": stage, "reason": reason}
        now = self._now()
        await self._contents.update(content.id, now, **state, **fields)
        await self._records.update_for_content(content.id, now, **state)
