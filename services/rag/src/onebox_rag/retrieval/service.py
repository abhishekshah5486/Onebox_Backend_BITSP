"""Ranked passages with citations for a question over a user's records: hybrid search, hits
grouped into units, neighbouring paragraphs in the room left."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any

from onebox_rag.dates import DateBounds
from onebox_rag.index.embed import DenseEmbedder, SparseVector, sparse_query
from onebox_rag.index.points import citation_of
from onebox_rag.index.qdrant_store import TITLE, Hit, QdrantStore, SearchTuning, collection_name
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Content, Record, Status
from onebox_rag.models.blocks import BlocksContainer
from onebox_rag.models.records import DateOrigin
from onebox_rag.pipeline.parse import decode_blocks
from onebox_rag.retrieval.units import (
    Unit,
    UnitSettings,
    add_neighbours,
    build_units,
    cut_by_record,
    rank,
)

logger = logging.getLogger("onebox_rag.retrieval")
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
    # Records found by name whose content is not indexed yet: the title search reads this
    # deep (indexed records share it), keeps those above the cosine floor, lists this many.
    title_depth: int = 25
    title_min_score: float = 0.45
    unindexed_max: int = 10
    # A search with date bounds also runs once without them (this many results) and lists
    # the best few records the dates left out, each with up to this many passages.
    outside_dates: bool = True
    # Uploads dated only by when they were uploaded pass upper bounds (content dates on).
    uploads_undated: bool = False
    outside_dates_limit: int = 10
    outside_dates_max: int = 3
    outside_dates_passages: int = 3


# Bounds match when a record was written or last changed, not when what it describes
# happened: a later write-up about the period is left out however well it matches.
OUTSIDE_DATES_NOTE = (
    "Also matching, but written outside your dates, so the date filter left them out of the "
    "results: the best matches of the same search without dates, each with its dates. A later "
    "write-up, such as release notes, a retrospective or a weekly summary, can still be about "
    "your period."
)

# Said beside results that may not be all there, so "nothing found" isn't taken as "none".
TITLE_LOOKUP_FAILED = (
    "The lookup of records by name did not finish, so a record not read yet may exist even "
    "though none is listed."
)


@dataclass
class Retrieved:
    chunks: list[dict[str, Any]] = field(default_factory=list)
    # Records whose names match but whose content can't be searched yet (still being read,
    # or failed): search can't see their text, so they are named apart.
    unindexed: list[dict[str, Any]] = field(default_factory=list)
    # Part of the search could not run; what was found stands.
    incomplete: str | None = None
    # What the search can't see yet: {code, count, message}.
    notices: list[dict[str, Any]] = field(default_factory=list)
    # Records the date bounds left out that match without them, best first.
    outside_dates: list[dict[str, Any]] = field(default_factory=list)


class Retriever:
    def __init__(
        self,
        records: RecordStore,
        contents: ContentStore,
        blobs: BlobStore,
        dense: DenseEmbedder,
        store: QdrantStore,
        settings: RetrieveSettings,
        # Contents a search returned, for those waiting on their first use to be classified.
        returned: Callable[[list[Content]], Awaitable[None]] | None = None,
    ) -> None:
        self._returned = returned
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
        dates: DateBounds | None = None,
        # The user's own choices, over the server's.
        outside_dates: bool | None = None,
        uploads_undated: bool | None = None,
    ) -> Retrieved:
        dates = dates if dates is not None and dates.given() else None
        net = self._settings.outside_dates if outside_dates is None else outside_dates
        no_upper = self._settings.uploads_undated if uploads_undated is None else uploads_undated
        if dates is not None and no_upper:
            dates = replace(dates, uploads_undated=True)
        notices = await self._notices(user_id, scope, dates)
        content_ids = None
        if scope.given():
            content_ids = await self._records.scoped_contents(user_id, **scope.fields())
            if not content_ids:
                return Retrieved(notices=notices)
        model = await self._dense.model_for(user_id)
        collection = collection_name(model)
        if not await self._store.exists(collection):
            return Retrieved(notices=notices)
        dense, sparse = await asyncio.gather(
            self._dense.embed(user_id, model, [query]), asyncio.to_thread(sparse_query, query)
        )
        search = (user_id, collection, dense[0], sparse, content_ids, scope)
        unindexed = asyncio.create_task(
            self._unindexed(user_id, collection, dense[0], content_ids, scope, dates)
        )
        undated = (
            asyncio.create_task(
                self._quietly(self._chunks(*search, None, self._settings.outside_dates_limit, None))
            )
            if dates is not None and net
            else None
        )
        try:
            cited = await self._chunks(*search, dates, limit, max_per_record)
        except BaseException:
            unindexed.cancel()
            if undated is not None:
                undated.cancel()
            raise
        names = await unindexed
        outside = (
            self._outside(await undated, dates, {r.id for _, r in cited})
            if undated is not None and dates is not None
            else []
        )
        return Retrieved(
            [chunk for chunk, _ in cited],
            names or [],
            TITLE_LOOKUP_FAILED if names is None else None,
            notices,
            outside,
        )

    async def _quietly(
        self, search: Awaitable[list[tuple[dict[str, Any], Record]]]
    ) -> list[tuple[dict[str, Any], Record]]:
        """The net only adds to a search: its own failure leaves the result as it was."""
        try:
            return await search
        except Exception:
            logger.warning("search without dates failed; results unchanged", exc_info=True)
            return []

    def _outside(
        self,
        found: list[tuple[dict[str, Any], Record]],
        dates: DateBounds,
        shown: set[str],
    ) -> list[dict[str, Any]]:
        """The best records of the search without dates that the bounds leave out, in its
        order. One inside the bounds was ranked too low, not left out by dates: skipped."""
        settings = self._settings
        picked: dict[str, list[dict[str, Any]]] = {}
        skipped: set[str] = set()
        for chunk, record in found:
            if record.id in skipped:
                continue
            if record.id in picked:
                if len(picked[record.id]) < settings.outside_dates_passages:
                    picked[record.id].append(chunk)
                continue
            if (
                len(picked) >= settings.outside_dates_max
                or record.id in shown
                or dates.admits(
                    *record.dates(), upload_dated=record.date_origin == DateOrigin.UPLOAD
                )
            ):
                skipped.add(record.id)
                continue
            picked[record.id] = [chunk]
        return [chunk for chunks in picked.values() for chunk in chunks]

    async def _notices(
        self, user_id: str, scope: Scope, dates: DateBounds | None
    ) -> list[dict[str, Any]]:
        notices = []
        reading = await self._records.count_reading(user_id, dates, **scope.fields())
        if reading:
            notices.append(
                {
                    "code": "STILL_READING",
                    "count": reading,
                    "message": f"{reading} record{'s are' if reading != 1 else ' is'} still being "
                    "read, so their text can't be searched yet.",
                }
            )
        if dates is not None:
            waiting = await self._contents.undated_for(user_id)
            undated = await self._records.count_holding(user_id, waiting, **scope.fields())
            if undated:
                notices.append(
                    {
                        "code": "DATES_PENDING",
                        "count": undated,
                        "message": f"{undated} record{'s' if undated != 1 else ''} can't be "
                        "searched by date yet; a search without dates finds them.",
                    }
                )
        return notices

    async def _chunks(
        self,
        user_id: str,
        collection: str,
        dense: list[float],
        sparse: SparseVector,
        content_ids: list[str] | None,
        scope: Scope,
        dates: DateBounds | None,
        limit: int,
        max_per_record: int | None,
    ) -> list[tuple[dict[str, Any], Record]]:
        cut = self._settings.record_cut
        fetch = limit
        if cut.enabled:
            fetch = max(limit, min(limit * cut.depth, MAX_FETCH))
        if max_per_record is not None:
            fetch = max(fetch, min(limit * self._settings.cap_overfetch, MAX_FETCH))
        hits = await self._store.search(
            collection,
            dense,
            sparse,
            user_id=user_id,
            content_ids=content_ids,
            limit=fetch,
            tuning=self._settings.tuning,
            dates=dates,
        )
        contents, containers = await self._load(hits)
        if self._returned is not None:
            try:
                await self._returned(list(contents.values()))
            except Exception:
                logger.warning("first-use classify not queued", exc_info=True)
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
            user_id, list({u.content_id for u in units}), dates, **scope.fields()
        )
        cited = [(unit, record) for unit in units if (record := _record_for(unit, held))]
        # An attachment is cited with the email it came with.
        parents = {
            r.parent_id: await self._records.get(user_id, r.parent_id)
            for _, r in cited
            if r.parent_id and r.mail is None
        }
        return [
            (
                _chunk(
                    unit, record, containers[unit.content_id], parents.get(record.parent_id or "")
                ),
                record,
            )
            for unit, record in cited
        ]

    async def matching_blocks(
        self, user_id: str, content: Content, query: str, limit: int = 60
    ) -> list[int]:
        """The content's blocks matching `query`, best first: a search limited to it, asked for
        generously since the reader's room, not this count, decides how many are shown."""
        model = await self._dense.model_for(user_id)
        collection = collection_name(model)
        if content.index_collection != collection:
            return []
        dense, sparse = await asyncio.gather(
            self._dense.embed(user_id, model, [query]), asyncio.to_thread(sparse_query, query)
        )
        hits = await self._store.search(
            collection,
            dense[0],
            sparse,
            user_id=user_id,
            content_ids=[content.id],
            limit=limit,
            tuning=self._settings.tuning,
        )
        found = []
        for hit in hits:
            if hit.payload.get("revision") != content.revision:
                continue  # a title, or a revision being replaced
            index = hit.payload.get("blockIndex")
            if isinstance(index, int):
                found.append(index)
        return found

    async def _unindexed(
        self,
        user_id: str,
        collection: str,
        dense: list[float],
        content_ids: list[str] | None,
        scope: Scope,
        dates: DateBounds | None,
    ) -> list[dict[str, Any]] | None:
        """None when the lookup failed (the passages stand without it)."""
        settings = self._settings
        if settings.unindexed_max == 0:
            return []
        try:
            hits = await self._store.search_titles(
                collection,
                dense,
                user_id=user_id,
                content_ids=content_ids,
                limit=settings.title_depth,
                min_score=settings.title_min_score,
                dates=dates,
            )
            ids = list({str(h.payload.get("contentId")) for h in hits})
            contents = await self._contents.get_many(ids) if ids else {}
            waiting = {c.id for c in contents.values() if c.status != Status.COMPLETED}
            held = await self._records.holding(user_id, list(waiting), dates, **scope.fields())
        except Exception:
            logger.warning("title search failed", exc_info=True)
            return None
        by_id = {r.id: r for records in held.values() for r in records}
        found: list[dict[str, Any]] = []
        for hit in hits:
            record = by_id.pop(str(hit.payload.get("recordId")), None)
            if record is None:
                continue
            content = contents[record.content_id]
            found.append(
                {
                    "recordId": record.id,
                    "name": record.name,
                    "status": content.status,
                    **({"reason": content.reason} if content.reason else {}),
                    "score": hit.score,
                }
            )
        return found[: settings.unindexed_max]

    async def _load(self, hits: list[Hit]) -> tuple[dict[str, Content], dict[str, BlocksContainer]]:
        ids = list({str(h.payload.get("contentId")) for h in hits})
        contents = await self._contents.get_many(ids) if ids else {}
        usable = [c for c in contents.values() if c.blocks_key]

        async def blocks(content: Content) -> BlocksContainer:
            assert content.blocks_key is not None
            return decode_blocks(await self._blobs.get(content.blocks_key))

        loaded = await asyncio.gather(*(blocks(c) for c in usable))
        return contents, {c.id: b for c, b in zip(usable, loaded, strict=True)}


def _record_for(unit: Unit, held: dict[str, list[Record]]) -> Record | None:
    """The newest record holding the unit's content, or for a title hit that title's own
    record (left out when the scope or dates leave it out)."""
    records = held.get(unit.content_id) or []
    if unit.record_id is None:
        return records[0] if records else None
    return next((r for r in records if r.id == unit.record_id), None)


def _current(hit: Hit, contents: dict[str, Content]) -> bool:
    if hit.payload.get("kind") == TITLE:
        return hit.payload.get("contentId") in contents  # belongs to its record, not a revision
    content = contents.get(str(hit.payload.get("contentId")))
    return content is not None and content.revision == hit.payload.get("revision")


def _chunk(
    unit: Unit, record: Record, container: BlocksContainer, parent: Record | None = None
) -> dict[str, Any]:
    block = container.blocks[unit.block_index] if unit.block_index < len(container.blocks) else None
    cite = citation_of(block) if block is not None and unit.kind != "summary" else {}
    if unit.kind == "table" and unit.group_index is not None and not cite:
        group_cite = container.block_groups[unit.group_index].citation_metadata
        if group_cite is not None:
            cite = {"page": group_cite.page_number, "sheet": group_cite.sheet_name}
    where = unit.group_index if unit.kind in {"table", "list"} else unit.block_index
    if unit.kind in {"record", "summary"}:
        where = 0
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
            "dates": _dates(record),
            **({"mail": _mail(record)} if record.mail is not None else {}),
            **(
                {"attachedTo": {"recordId": parent.id, "name": parent.name, "mail": _mail(parent)}}
                if parent is not None and parent.mail is not None
                else {}
            ),
        },
        "citation": {
            **{k: v for k, v in cite.items() if v is not None},
            "blockIndex": unit.block_index,
            "blockIndices": unit.blocks,
            **({"neighbourOf": unit.neighbour_of} if unit.neighbour_of is not None else {}),
        },
    }


def _dates(record: Record) -> dict[str, Any]:
    """When the record was written and last changed, and where those dates came from (an
    upload's may be only when it was uploaded)."""
    created, modified = record.dates()
    return {
        "created": created.isoformat(),
        "modified": modified.isoformat(),
        "origin": record.date_origin,
    }


def _mail(record: Record) -> dict[str, Any]:
    """Who wrote an email to whom and when, which its body rarely says."""
    assert record.mail is not None
    return record.mail.model_dump(
        by_alias=True,
        mode="json",
        include={"thread_id", "sender", "to", "cc", "received_at"},
        exclude_none=True,
    )
