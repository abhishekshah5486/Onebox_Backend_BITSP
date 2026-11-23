"""Ranked passages with citations for a question over a user's records: hybrid search, hits
grouped into units, neighbouring paragraphs in the room left."""

import asyncio
from dataclasses import dataclass, field
from typing import Any

from onebox_rag.index.embed import DenseEmbedder, sparse_query
from onebox_rag.index.points import citation_of
from onebox_rag.index.qdrant_store import Hit, QdrantStore, SearchTuning, collection_name
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Content, Record
from onebox_rag.models.blocks import BlocksContainer
from onebox_rag.pipeline.parse import decode_blocks
from onebox_rag.retrieval.units import (
    Unit,
    UnitSettings,
    add_neighbours,
    build_units,
    cut_by_record,
    rank,
)

# A search reads at most this many hits, however deep it is asked to go.
MAX_FETCH = 300


@dataclass(frozen=True)
class Scope:
    source_ids: list[str] | None = None  # knowledge bases, mail accounts
    source_types: list[str] | None = None
    record_ids: list[str] | None = None

    def given(self) -> bool:
        return any(v is not None for v in (self.source_ids, self.source_types, self.record_ids))

    def fields(self) -> dict[str, list[str] | None]:
        return {
            "source_ids": self.source_ids,
            "source_types": self.source_types,
            "record_ids": self.record_ids,
        }


@dataclass(frozen=True)
class RecordCut:
    """Off by default: fetch `depth` times deeper, then keep at most `max(floor, limit //
    divisor)` hits per record in the best half and give the rest to unrepresented records."""

    enabled: bool = False
    depth: int = 3
    new_record_share: float = 0.5
    per_record_floor: int = 4
    per_record_divisor: int = 6

    def per_record(self, limit: int) -> int:
        return max(self.per_record_floor, limit // self.per_record_divisor)


@dataclass(frozen=True)
class RetrieveSettings:
    tuning: SearchTuning = field(default_factory=SearchTuning)
    record_cut: RecordCut = field(default_factory=RecordCut)
    units: UnitSettings = field(default_factory=UnitSettings)
    # With a per-record cap, read this many times deeper so capped records leave room.
    cap_overfetch: int = 3


class Retriever:
    def __init__(
        self,
        records: RecordStore,
        contents: ContentStore,
        blobs: BlobStore,
        dense: DenseEmbedder,
        store: QdrantStore,
        settings: RetrieveSettings,
    ) -> None:
        self._records, self._contents, self._blobs = records, contents, blobs
        self._dense, self._store, self._settings = dense, store, settings

    async def retrieve(
        self,
        user_id: str,
        query: str,
        *,
        limit: int,
        scope: Scope,
        max_per_record: int | None = None,
    ) -> list[dict[str, Any]]:
        content_ids = None
        if scope.given():
            content_ids = await self._records.scoped_contents(user_id, **scope.fields())
            if not content_ids:
                return []
        model = await self._dense.model_for(user_id)
        collection = collection_name(model)
        if not await self._store.exists(collection):
            return []
        dense, sparse = await asyncio.gather(
            self._dense.embed(user_id, model, [query]), asyncio.to_thread(sparse_query, query)
        )
        cut = self._settings.record_cut
        fetch = limit
        if cut.enabled:
            fetch = max(limit, min(limit * cut.depth, MAX_FETCH))
        if max_per_record is not None:
            fetch = max(fetch, min(limit * self._settings.cap_overfetch, MAX_FETCH))
        hits = await self._store.search(
            collection,
            dense[0],
            sparse,
            user_id=user_id,
            content_ids=content_ids,
            limit=fetch,
            tuning=self._settings.tuning,
        )
        contents, containers = await self._load(hits)
        # Points of a revision being replaced are skipped: their block indices are its own.
        hits = [h for h in hits if _current(h, contents)]
        if cut.enabled:
            hits = cut_by_record(
                hits,
                limit,
                per_record=cut.per_record(limit),
                reserve=int(limit * cut.new_record_share),
                record_of=lambda h: str(h.payload.get("contentId")),
            )
        ranked = rank(build_units(hits, containers, self._settings.units), limit, max_per_record)
        units = add_neighbours(ranked, containers, spare=limit - len(ranked))
        held = await self._records.holding(
            user_id, list({u.content_id for u in units}), **scope.fields()
        )
        return [
            _chunk(unit, held[unit.content_id], containers[unit.content_id])
            for unit in units
            if unit.content_id in held
        ]

    async def _load(self, hits: list[Hit]) -> tuple[dict[str, Content], dict[str, BlocksContainer]]:
        ids = list({str(h.payload.get("contentId")) for h in hits})
        contents = await self._contents.get_many(ids) if ids else {}
        usable = [c for c in contents.values() if c.blocks_key]

        async def blocks(content: Content) -> BlocksContainer:
            assert content.blocks_key is not None
            return decode_blocks(await self._blobs.get(content.blocks_key))

        loaded = await asyncio.gather(*(blocks(c) for c in usable))
        return contents, {c.id: b for c, b in zip(usable, loaded, strict=True)}


def _current(hit: Hit, contents: dict[str, Content]) -> bool:
    content = contents.get(str(hit.payload.get("contentId")))
    return content is not None and content.revision == hit.payload.get("revision")


def _chunk(unit: Unit, record: Record, container: BlocksContainer) -> dict[str, Any]:
    block = container.blocks[unit.block_index] if unit.block_index < len(container.blocks) else None
    cite = citation_of(block) if block is not None else {}
    if unit.kind == "table" and unit.group_index is not None and not cite:
        group_cite = container.block_groups[unit.group_index].citation_metadata
        if group_cite is not None:
            cite = {"page": group_cite.page_number, "sheet": group_cite.sheet_name}
    where = unit.group_index if unit.kind in {"table", "list"} else unit.block_index
    return {
        # The same for the same passage across calls, so callers can dedupe and cache.
        "id": f"{record.id}:{unit.kind}:{where}",
        "text": unit.text,
        "score": unit.score,
        "kind": unit.kind,
        "record": {
            "recordId": record.id,
            "name": record.name,
            "mimeType": record.mime_type,
            "sourceType": record.source_type,
            "sourceId": record.source_id,
            "updatedAt": record.updated_at.isoformat(),
        },
        "citation": {
            **{k: v for k, v in cite.items() if v is not None},
            "blockIndex": unit.block_index,
            "blockIndices": unit.blocks,
            **({"neighbourOf": unit.neighbour_of} if unit.neighbour_of is not None else {}),
        },
    }
