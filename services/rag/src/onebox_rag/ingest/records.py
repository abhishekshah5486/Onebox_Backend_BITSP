from datetime import datetime
from typing import Any

from pydantic.alias_generators import to_camel
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from onebox_rag.dates import DateBounds
from onebox_rag.models import Content, Record

Doc = dict[str, Any]


def _set(fields: dict[str, Any], now: datetime) -> Doc:
    # Callers pass model field names; documents store them camelCase.
    return {"$set": {**{to_camel(k): v for k, v in fields.items()}, "updatedAt": now}}


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

    async def undated(self, limit: int = 1000) -> list[str]:
        cursor = self._contents.find(
            {"status": "completed", "indexCollection": {"$ne": None}, "pointsDated": {"$ne": True}},
            {"_id": 1},
        ).limit(limit)
        return [str(doc["_id"]) async for doc in cursor]

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

    async def get(self, user_id: str, record_id: str) -> Record | None:
        doc = await self._records.find_one({"_id": record_id, "userId": user_id})
        return Record.model_validate(doc) if doc else None

    async def find(
        self, user_id: str, *, limit: int, before: datetime | None = None, **filters: Any
    ) -> list[Record]:
        query: Doc = {"userId": user_id, **{k: v for k, v in filters.items() if v is not None}}
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

    async def untitled(self, limit: int = 1000) -> list[Record]:
        cursor = self._records.find({"titled": {"$ne": True}}).limit(limit)
        return [Record.model_validate(doc) async for doc in cursor]

    async def holds_content(self, content_id: str) -> bool:
        return await self._records.count_documents({"contentId": content_id}, limit=1) > 0

    async def children(self, user_id: str, parent_id: str) -> list[Record]:
        cursor = self._records.find({"userId": user_id, "parentId": parent_id})
        return [Record.model_validate(doc) async for doc in cursor]

    async def delete(self, record_ids: list[str]) -> None:
        await self._records.delete_many({"_id": {"$in": record_ids}})


SCOPE_FIELDS = {"source_ids": "sourceId", "source_types": "sourceType", "record_ids": "_id"}


def _scope(user_id: str, scope: dict[str, list[str] | None]) -> Doc:
    query: Doc = {"userId": user_id}
    for name, values in scope.items():
        if values is not None:
            query[SCOPE_FIELDS[name]] = {"$in": values}
    return query


def _dated(dates: DateBounds | None) -> Doc:
    query: Doc = {}
    if dates is None:
        return query
    for field, after, before in (
        ("sourceCreatedAt", dates.created_after, dates.created_before),
        ("sourceModifiedAt", dates.modified_after, dates.modified_before),
    ):
        bound = {k: v for k, v in (("$gte", after), ("$lte", before)) if v is not None}
        if bound:
            query[field] = bound
    return query
