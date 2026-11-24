import asyncio
import hashlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from onebox_rag.index.embed import (
    SPARSE_MODEL,
    DenseEmbedder,
    EmbeddingModel,
    EmbeddingUnavailableError,
    sparse_documents,
)
from onebox_rag.index.points import PointText, SplitSettings, point_texts
from onebox_rag.index.qdrant_store import QdrantStore, StoredPoint
from onebox_rag.index.stray import sweep_stray_points
from onebox_rag.index.tokens import TokenLimitError
from onebox_rag.index.upkeep import PointUpkeep
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.content_dates import find_document_dates, plan_dates
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import TERMINAL, Content, SourceType, Stage, Status
from onebox_rag.models.blocks import BlocksContainer
from onebox_rag.models.records import DateOrigin, EmbedMarker
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
        # The upload dates a date its content states may replace (none: off).
        content_dates: frozenset[DateOrigin] = frozenset(),
        # Classify (and summarize) once searchable: queues it, or waits for its first search.
        classify: Callable[[Content], Awaitable[None]] | None = None,
        # Points embedded and written together, each batch durable before the next.
        write_batch: int = 512,
        # Points of a content listed per run by the stray sweep (0: off).
        stray_max_points: int = 100_000,
    ) -> None:
        self._write_batch, self._stray_max_points = write_batch, stray_max_points
        # Where a stray sweep that stopped at its bound resumes (per process: losing it only
        # restarts that content's sweep).
        self._sweep_offsets: dict[str, str] = {}
        self._contents, self._records, self._blobs = contents, records, blobs
        self._content_dates = content_dates
        self._classify = classify
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
            wanted = await self._write(content, model, collection, texts)
            await self._store.delete_content(collection, content.id, keep_revision=revision)
            await self._sweep(collection, content.id, wanted)
            if content.index_collection and content.index_collection != collection:
                # Indexed before with another embedding model: its records' titles move too.
                await self._store.delete_content(content.index_collection, content.id)
                moved = True
        except TokenLimitError as err:
            # Every try would fail the same way until the user picks another model.
            logger.warning("embedding input too small", extra={"contentId": content_id})
            await self._settle(
                content, Status.FAILED, stage=Stage.INDEX, reason=str(err), embed_marker=None
            )
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
            point_count=len(wanted),
            points_dated=False,
            embed_marker=None,
        )
        redated: list[str] = []
        try:
            redated = await self._date_uploads(content_id, container)
        except Exception:
            logger.warning("content dates failed", extra={"contentId": content_id}, exc_info=True)
        if self._classify is not None:
            try:
                await self._classify(content)
            except Exception:
                logger.warning(
                    "classify not queued", extra={"contentId": content_id}, exc_info=True
                )
        if self._upkeep is not None:
            try:
                await self._upkeep.sync(content_id, redated, retitle=moved)
            except Exception:
                # Searchable already; its dates and header points follow on the next sweep.
                logger.warning(
                    "point upkeep failed", extra={"contentId": content_id}, exc_info=True
                )
        logger.info(
            "indexed",
            extra={"contentId": content_id, "points": len(wanted), "collection": collection},
        )

    async def _write(
        self, content: Content, model: EmbeddingModel, collection: str, texts: list[PointText]
    ) -> set[str]:
        """Writes the revision's points a batch at a time, each durable once written. A retry
        of the same revision, embedding setup and points embeds only those still missing."""
        unique: dict[str, PointText] = {}
        for text in texts:
            unique.setdefault(text.point_id(content.id, content.revision), text)
        wanted = list(unique)
        marker = EmbedMarker(
            revision=content.revision,
            collection=collection,
            key=embed_key(model),
            digest=digest_of(wanted),
            total=len(wanted),
        )
        resuming = content.embed_marker == marker
        if resuming:
            present = await self._store.existing_ids(collection, wanted)
            logger.info(
                "resuming index",
                extra={"contentId": content.id, "present": len(present), "total": len(wanted)},
            )
        else:
            present = set()
            await self._contents.update(
                content.id, self._now(), embed_marker=marker.model_dump(by_alias=True)
            )
        todo = [unique[point_id] for point_id in wanted if point_id not in present]
        for start in range(0, len(todo), self._write_batch):
            batch = todo[start : start + self._write_batch]
            await self._store.upsert(collection, await self._points(content, model, batch))
        if resuming:
            missing = len(wanted) - len(await self._store.existing_ids(collection, wanted))
            if missing:
                raise RuntimeError(f"{missing} of {len(wanted)} points are missing after a resume")
        return set(wanted)

    async def _sweep(self, collection: str, content_id: str, keep: set[str]) -> None:
        if not self._stray_max_points:
            return
        try:
            result = await sweep_stray_points(
                self._store,
                collection,
                content_id,
                keep,
                max_points=self._stray_max_points,
                resume=self._sweep_offsets.pop(content_id, None),
            )
        except Exception:
            logger.warning("stray sweep failed", extra={"contentId": content_id}, exc_info=True)
            return
        if result.next_offset is not None:
            self._sweep_offsets[content_id] = result.next_offset

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

    async def _date_uploads(self, content_id: str, container: BlocksContainer) -> list[str]:
        """Uploads of this content take the dates its header states, or get their own back;
        returns the records whose dates changed."""
        uploads = [
            r
            for r in await self._records.for_content(content_id)
            if r.source_type == SourceType.UPLOAD
        ]
        if not self._content_dates and all(r.date_origin != DateOrigin.CONTENT for r in uploads):
            return []
        changed = []
        for record in uploads:
            stated = find_document_dates(container, uploaded_at=record.created_at)
            fields = plan_dates(record, stated, self._content_dates)
            if fields is not None and await self._records.update(record.id, self._now(), **fields):
                changed.append(record.id)
        return changed

    async def _retry_or_fail(self, content: Content, final: bool, reason: str) -> None:
        if final:
            await self._settle(
                content, Status.FAILED, stage=Stage.INDEX, reason=reason, embed_marker=None
            )
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


def embed_key(model: EmbeddingModel) -> str:
    return f"{model.id}|{model.dimensions}|{SPARSE_MODEL}"


def digest_of(point_ids: list[str]) -> str:
    """Order-insensitive digest of a set of point ids."""
    h = hashlib.sha256()
    for point_id in sorted(set(point_ids)):
        h.update(point_id.encode())
        h.update(b"\n")
    return h.hexdigest()[:32]
