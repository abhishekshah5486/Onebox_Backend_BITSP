import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic.alias_generators import to_camel
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from onebox_rag.dates import DateBounds
from onebox_rag.models import Content, Record
from onebox_rag.models.records import TERMINAL, DateOrigin, Stage, Status

Doc = dict[str, Any]


def _set(fields: dict[str, Any], now: datetime) -> Doc:
    # Callers pass model field names; documents store them camelCase.
    return {"$set": {**{to_camel(k): v for k, v in fields.items()}, "updatedAt": now}}


RecordSort = Literal[
    "createdAt", "updatedAt", "sourceCreatedAt", "sourceModifiedAt", "name", "sizeBytes"
]


@dataclass(frozen=True)
class RecordFilter:
    # Part of the name, any case.
    name: str | None = None
    statuses: Sequence[str] | None = None
    source_types: Sequence[str] | None = None
    source_ids: Sequence[str] | None = None
    mime_types: Sequence[str] | None = None
    min_size: int | None = None
    max_size: int | None = None
    # The record's own dates, as a search's date bounds read them.
    dates: DateBounds | None = None
    # Folders it sits in; None in the list for the top of a collection.
    folder_ids: Sequence[str | None] | None = None
    # The trash instead of the records in use.
    trashed: bool = False

    def query(self) -> Doc:
        query: Doc = _trash(self.trashed)
        if self.folder_ids is not None:
            query["folderId"] = {"$in": list(self.folder_ids)}
        if self.name:
            query["name"] = {"$regex": re.escape(self.name), "$options": "i"}
        for field, values in (
            ("status", self.statuses),
            ("sourceType", self.source_types),
            ("sourceId", self.source_ids),
            ("mimeType", self.mime_types),
        ):
            if values:
                query[field] = {"$in": values}
        size = {
            k: v for k, v in (("$gte", self.min_size), ("$lte", self.max_size)) if v is not None
        }
        if size:
            query["sizeBytes"] = size
        return {**query, **_dated(self.dates)}


class ContentStore:
    """One document per user and set of bytes (a "virtual record")."""

    def __init__(self, db: AsyncDatabase[Doc]) -> None:
        self._contents = db["contents"]

    async def ensure_indexes(self) -> None:
        await self._contents.create_index(
            [("userId", ASCENDING), ("sha256", ASCENDING)], unique=True
        )

    async def claim(self, content: Content) -> tuple[Content, bool]:
        """Saves new content, or returns what is already stored for those bytes (and False)."""
        try:
            await self._contents.insert_one(content.model_dump(by_alias=True))
        except DuplicateKeyError:
            existing = await self.get(content.id)
            if existing is None:
                raise
            return existing, False
        return content, True

    async def get(self, content_id: str) -> Content | None:
        doc = await self._contents.find_one({"_id": content_id})
        return Content.model_validate(doc) if doc else None

    async def get_many(self, content_ids: list[str]) -> dict[str, Content]:
        cursor = self._contents.find({"_id": {"$in": content_ids}})
        return {doc["_id"]: Content.model_validate(doc) async for doc in cursor}

    async def update(self, content_id: str, now: datetime, **fields: Any) -> Content | None:
        doc = await self._contents.find_one_and_update(
            {"_id": content_id},
            _set(fields, now),
            return_document=ReturnDocument.AFTER,
        )
        return Content.model_validate(doc) if doc else None

    async def restart(self, content: Content, now: datetime) -> Content | None:
        """Reads a settled content again under its next revision, from its stored file; None
        when it moved on meanwhile (being read, or restarted by another request)."""
        settled = [s.value for s in TERMINAL]
        doc = await self._contents.find_one_and_update(
            {"_id": content.id, "revision": content.revision, "status": {"$in": settled}},
            {
                "$set": {
                    "revision": content.revision + 1,
                    "status": Status.QUEUED.value,
                    "stage": Stage.PARSE.value,
                    "reason": None,
                    # Chosen per revision: a new one decides again.
                    "engine": None,
                    "engineReason": None,
                    "ocrProvider": None,
                    "workerDeaths": 0,
                    "updatedAt": now,
                }
            },
            return_document=ReturnDocument.AFTER,
        )
        return Content.model_validate(doc) if doc else None

    async def undated_for(self, user_id: str, limit: int = 1000) -> list[str]:
        cursor = self._contents.find(
            {"userId": user_id, "status": "completed", "pointsDated": {"$ne": True}}, {"_id": 1}
        ).limit(limit)
        return [str(doc["_id"]) async for doc in cursor]

    async def undated(self, limit: int = 1000) -> list[str]:
        cursor = self._contents.find(
            {"status": "completed", "indexCollection": {"$ne": None}, "pointsDated": {"$ne": True}},
            {"_id": 1},
        ).limit(limit)
        return [str(doc["_id"]) async for doc in cursor]

    async def stalled(self, before: datetime, limit: int = 100) -> list[Content]:
        """Contents waiting for a stage since before `before`: their job may have been lost."""
        stages = [Stage.PARSE.value, Stage.INDEX.value]
        query = {
            "status": Status.QUEUED.value,
            "stage": {"$in": stages},
            "updatedAt": {"$lt": before},
        }
        return [Content.model_validate(d) async for d in self._contents.find(query).limit(limit)]

    async def delete(self, content_id: str) -> None:
        await self._contents.delete_one({"_id": content_id})


class RecordStore:
    def __init__(self, db: AsyncDatabase[Doc]) -> None:
        self._records = db["records"]

    async def ensure_indexes(self) -> None:
        # One record per item in a source, so re-ingesting it finds the existing one.
        await self._records.create_index(
            [
                ("userId", ASCENDING),
                ("sourceType", ASCENDING),
                ("sourceId", ASCENDING),
                ("externalId", ASCENDING),
            ],
            unique=True,
        )
        await self._records.create_index([("userId", ASCENDING), ("createdAt", DESCENDING)])
        await self._records.create_index([("contentId", ASCENDING)])
        await self._records.create_index([("parentId", ASCENDING)], sparse=True)
        await self._records.create_index([("mail.copyIds", ASCENDING)], sparse=True)
        await self._records.create_index([("titled", ASCENDING)])
        # Records made before they had source dates take their own.
        await self._records.update_many(
            {"sourceCreatedAt": None},
            [{"$set": {"sourceCreatedAt": "$createdAt", "sourceModifiedAt": "$createdAt"}}],
        )

    async def insert(self, record: Record) -> tuple[Record, bool]:
        """Saves the record, or returns the one already there for the same item (and False)."""
        try:
            await self._records.insert_one(record.model_dump(by_alias=True))
        except DuplicateKeyError:
            existing = await self._records.find_one(
                {
                    "userId": record.user_id,
                    "sourceType": record.source_type,
                    "sourceId": record.source_id,
                    "externalId": record.external_id,
                }
            )
            if existing is None:
                raise
            return Record.model_validate(existing), False
        return record, True

    async def get(
        self, user_id: str, record_id: str, *, trashed: bool | None = False
    ) -> Record | None:
        """False: only one not in the trash; True: only one in it; None: either."""
        query: Doc = {"_id": record_id, "userId": user_id, **_trash(trashed)}
        doc = await self._records.find_one(query)
        return Record.model_validate(doc) if doc else None

    async def find(
        self, user_id: str, *, limit: int, before: datetime | None = None, **filters: Any
    ) -> list[Record]:
        query: Doc = {"userId": user_id, "deletedAt": None}
        query.update({k: v for k, v in filters.items() if v is not None})
        if before is not None:
            query["createdAt"] = {"$lt": before}
        cursor = self._records.find(query).sort("createdAt", DESCENDING).limit(limit)
        return [Record.model_validate(doc) async for doc in cursor]

    async def update(self, record_id: str, now: datetime, **fields: Any) -> Record | None:
        doc = await self._records.find_one_and_update(
            {"_id": record_id},
            _set(fields, now),
            return_document=ReturnDocument.AFTER,
        )
        return Record.model_validate(doc) if doc else None

    async def update_for_content(self, content_id: str, now: datetime, **fields: Any) -> None:
        await self._records.update_many({"contentId": content_id}, _set(fields, now))

    async def for_content(self, content_id: str) -> list[Record]:
        return [
            Record.model_validate(d) async for d in self._records.find({"contentId": content_id})
        ]

    async def page(
        self,
        user_id: str,
        filters: RecordFilter,
        *,
        sort: RecordSort = "createdAt",
        descending: bool = True,
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[Record], int]:
        """A page of the user's records that pass the filters, and how many pass in all."""
        query = {"userId": user_id, **filters.query()}
        direction = DESCENDING if descending else ASCENDING
        cursor = (
            self._records.find(query)
            .sort([(sort, direction), ("_id", direction)])
            .skip(offset)
            .limit(limit)
        )
        found = [Record.model_validate(doc) async for doc in cursor]
        return found, await self._records.count_documents(query)

    async def facets(self, user_id: str) -> dict[str, dict[str, int]]:
        """How many of the user's records are in each status and of each file type."""
        cursor = await self._records.aggregate(
            [
                {"$match": {"userId": user_id, "deletedAt": None}},
                {
                    "$facet": {
                        "statuses": [{"$group": {"_id": "$status", "n": {"$sum": 1}}}],
                        "mimeTypes": [{"$group": {"_id": "$mimeType", "n": {"$sum": 1}}}],
                    }
                },
            ]
        )
        row = await cursor.next()
        return {
            name: {group["_id"]: group["n"] for group in row[name]}
            for name in ("statuses", "mimeTypes")
        }

    async def orphans(self, limit: int = 100) -> list[Record]:
        """Records waiting on a content that no longer exists (lost by an older failed store)."""
        cursor = await self._records.aggregate(
            [
                {"$match": {"status": {"$in": [Status.QUEUED.value, Status.IN_PROGRESS.value]}}},
                {
                    "$lookup": {
                        "from": "contents",
                        "localField": "contentId",
                        "foreignField": "_id",
                        "as": "c",
                    }
                },
                {"$match": {"c": {"$size": 0}}},
                {"$project": {"c": 0}},
                {"$limit": limit},
            ]
        )
        return [Record.model_validate(doc) async for doc in cursor]

    async def sources(self, user_id: str) -> list[dict[str, Any]]:
        """Each source (knowledge base or mail account) of the user: its records, how many are
        in each status, and when the last one arrived, newest first."""
        cursor = await self._records.aggregate(
            [
                {"$match": {"userId": user_id, "deletedAt": None}},
                {
                    "$group": {
                        "_id": {"type": "$sourceType", "id": "$sourceId", "status": "$status"},
                        "count": {"$sum": 1},
                        "last": {"$max": "$createdAt"},
                    }
                },
            ]
        )
        grouped: dict[tuple[str, str], dict[str, Any]] = {}
        async for row in cursor:
            key = (row["_id"]["type"], row["_id"]["id"])
            source = grouped.setdefault(
                key,
                {
                    "sourceType": key[0],
                    "sourceId": key[1],
                    "records": 0,
                    "statuses": {},
                    "last": None,
                },
            )
            source["records"] += row["count"]
            source["statuses"][row["_id"]["status"]] = row["count"]
            if source["last"] is None or row["last"] > source["last"]:
                source["last"] = row["last"]
        out = sorted(grouped.values(), key=lambda s: s["last"], reverse=True)
        for source in out:
            source["lastAddedAt"] = source.pop("last").isoformat()
        return out

    async def scoped_contents(self, user_id: str, **scope: list[str] | None) -> list[str]:
        """The contents of the user's records in the given sources, source types or records."""
        query = _scope(user_id, scope)
        return [str(c) for c in await self._records.distinct("contentId", query)]

    async def holding(
        self,
        user_id: str,
        content_ids: list[str],
        dates: DateBounds | None = None,
        **scope: list[str] | None,
    ) -> dict[str, list[Record]]:
        """For each content, the user's records holding it (within the scope and dates), newest
        first."""
        query = {**_scope(user_id, scope), **_dated(dates), "contentId": {"$in": content_ids}}
        held: dict[str, list[Record]] = {}
        async for doc in self._records.find(query).sort("createdAt", DESCENDING):
            held.setdefault(doc["contentId"], []).append(Record.model_validate(doc))
        return held

    async def by_external_id(
        self, user_id: str, source_type: str, source_id: str, external_id: str
    ) -> Record | None:
        doc = await self._records.find_one(
            {
                "userId": user_id,
                "sourceType": source_type,
                "sourceId": source_id,
                "externalId": external_id,
            }
        )
        return Record.model_validate(doc) if doc else None

    async def with_mail_copy(self, message_id: str) -> Record | None:
        doc = await self._records.find_one({"mail.copyIds": message_id})
        return Record.model_validate(doc) if doc else None

    async def count_reading(
        self, user_id: str, dates: DateBounds | None = None, **scope: list[str] | None
    ) -> int:
        """The user's records (within the scope and dates) whose content is still being read."""
        query = {**_scope(user_id, scope), **_dated(dates)}
        query["status"] = {"$in": ["queued", "in_progress"]}
        return await self._records.count_documents(query)

    async def count_holding(
        self, user_id: str, content_ids: list[str], **scope: list[str] | None
    ) -> int:
        if not content_ids:
            return 0
        query = {**_scope(user_id, scope), "contentId": {"$in": content_ids}}
        return await self._records.count_documents(query)

    async def untitled(self, limit: int = 1000) -> list[Record]:
        cursor = self._records.find({"titled": {"$ne": True}}).limit(limit)
        return [Record.model_validate(doc) async for doc in cursor]

    async def holds_content(self, content_id: str) -> bool:
        return await self._records.count_documents({"contentId": content_id}, limit=1) > 0

    async def children(self, user_id: str, parent_id: str) -> list[Record]:
        cursor = self._records.find({"userId": user_id, "parentId": parent_id})
        return [Record.model_validate(doc) async for doc in cursor]

    async def set_children(self, parent_id: str, now: datetime, **fields: Any) -> None:
        await self._records.update_many({"parentId": parent_id}, _set(fields, now))

    async def name_taken(
        self, user_id: str, kb_id: str, folder_id: str | None, name: str, exclude: str
    ) -> bool:
        query: Doc = {
            "userId": user_id,
            "sourceType": "upload",
            "sourceId": kb_id,
            "folderId": folder_id,
            "parentId": None,
            "deletedAt": None,
            "_id": {"$ne": exclude},
            "name": {"$regex": f"^{re.escape(name.strip())}$", "$options": "i"},
        }
        return await self._records.count_documents(query, limit=1) > 0

    async def in_folders(self, user_id: str, folder_ids: list[str]) -> list[Record]:
        cursor = self._records.find({"userId": user_id, "folderId": {"$in": folder_ids}})
        return [Record.model_validate(d) async for d in cursor]

    async def ids_in_source(self, user_id: str, source_type: str, source_id: str) -> list[str]:
        query = {
            "userId": user_id,
            "sourceType": source_type,
            "sourceId": source_id,
            "parentId": None,
        }
        return [str(i) for i in await self._records.distinct("_id", query)]

    async def trash(self, record_ids: list[str], now: datetime | None) -> None:
        """Into the trash (now) or out of it (None), with their attachments."""
        ids = {"$in": record_ids}
        update = _set({"deleted_at": now}, now or datetime.now(UTC))
        await self._records.update_many({"$or": [{"_id": ids}, {"parentId": ids}]}, update)

    async def delete(self, record_ids: list[str]) -> None:
        await self._records.delete_many({"_id": {"$in": record_ids}})


SCOPE_FIELDS = {"source_ids": "sourceId", "source_types": "sourceType", "record_ids": "_id"}


def _trash(trashed: bool | None) -> Doc:
    if trashed is None:
        return {}
    return {"deletedAt": {"$ne": None}} if trashed else {"deletedAt": None}


def _scope(user_id: str, scope: dict[str, list[str] | None]) -> Doc:
    query: Doc = {"userId": user_id, "deletedAt": None}
    for name, values in scope.items():
        if values is not None:
            query[SCOPE_FIELDS[name]] = {"$in": values}
    return query


def _dated(dates: DateBounds | None) -> Doc:
    if dates is None:
        return {}
    dated: Doc = {}
    lower: Doc = {}
    for field, after, before in (
        ("sourceCreatedAt", dates.created_after, dates.created_before),
        ("sourceModifiedAt", dates.modified_after, dates.modified_before),
    ):
        bound = {k: v for k, v in (("$gte", after), ("$lte", before)) if v is not None}
        if bound:
            dated[field] = bound
        if after is not None:
            lower[field] = {"$gte": after}
    if not dates.uploads_undated or dated == lower:
        return dated
    # An upload dated only by its upload was written then or earlier: no upper bound for it.
    return {"$or": [dated, {**lower, "dateOrigin": DateOrigin.UPLOAD.value}]}
