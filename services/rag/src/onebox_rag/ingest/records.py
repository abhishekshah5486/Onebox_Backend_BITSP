from datetime import datetime
from typing import Any

from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from onebox_rag.models import Record

Doc = dict[str, Any]


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
        await self._records.create_index([("parentId", ASCENDING)], sparse=True)

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

    async def set_status(self, record_id: str, now: datetime, **fields: Any) -> Record | None:
        doc = await self._records.find_one_and_update(
            {"_id": record_id},
            {"$set": {**fields, "updatedAt": now}},
            return_document=ReturnDocument.AFTER,
        )
        return Record.model_validate(doc) if doc else None

    async def children(self, user_id: str, parent_id: str) -> list[Record]:
        cursor = self._records.find({"userId": user_id, "parentId": parent_id})
        return [Record.model_validate(doc) async for doc in cursor]

    async def delete(self, record_ids: list[str]) -> None:
        await self._records.delete_many({"_id": {"$in": record_ids}})
