"""Collections (knowledge bases) and the folders inside them. Names are unique per user (a
collection) or per parent (a folder), compared trimmed and in any case."""

import re
import uuid
from datetime import datetime
from typing import Any

from pymongo import ASCENDING
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError

from onebox_rag.errors import ConflictError, NotFoundError, ValidationError
from onebox_rag.models.hub import Folder, KnowledgeBase

Doc = dict[str, Any]

# Folders nest at most this deep; one directly in a collection is depth 1.
MAX_FOLDER_DEPTH = 20
MAX_NAME_CHARS = 255
# Uploads made before collections were stored went into one named by its id.
LEGACY_NAMES = {"default": "My files"}


def name_key(name: str) -> str:
    return name.strip().casefold()


def _key(user_id: str, kb_id: str) -> str:
    return f"{user_id}:{kb_id}"


def clean_name(name: str, *, folder: bool) -> str:
    name = name.strip()
    if not name:
        raise ValidationError("A name is needed")
    if len(name) > MAX_NAME_CHARS:
        raise ValidationError(f"Names can be at most {MAX_NAME_CHARS} characters")
    if folder and re.search(r"[\\/]", name):
        raise ValidationError('Folder names cannot contain "/" or "\\"')
    return name


class KnowledgeBaseStore:
    def __init__(self, db: AsyncDatabase[Doc]) -> None:
        self._kbs = db["knowledge_bases"]
        self._records = db["records"]

    async def ensure_indexes(self) -> None:
        await self._kbs.create_index([("userId", ASCENDING), ("nameKey", ASCENDING)], unique=True)
        await self._adopt_legacy()

    async def _adopt_legacy(self) -> None:
        """Uploads made before collections were stored keep their collection id as its name."""
        pairs = await self._records.distinct("sourceId", {"sourceType": "upload"})
        for kb_id in pairs:
            async for row in await self._records.aggregate(
                [
                    {"$match": {"sourceType": "upload", "sourceId": kb_id}},
                    {"$group": {"_id": "$userId", "first": {"$min": "$createdAt"}}},
                ]
            ):
                if await self.get(row["_id"], kb_id) is None:
                    await self._insert_legacy(row["_id"], kb_id, row["first"])

    async def _insert_legacy(self, user_id: str, kb_id: str, at: datetime) -> None:
        name = LEGACY_NAMES.get(kb_id, kb_id)
        for attempt in range(1, 100):
            candidate = name if attempt == 1 else f"{name} ({attempt})"
            try:
                await self.create(user_id, candidate, at, kb_id=kb_id)
                return
            except ConflictError:
                if await self.get(user_id, kb_id) is not None:
                    return  # adopted meanwhile

    async def create(
        self, user_id: str, name: str, now: datetime, kb_id: str | None = None
    ) -> KnowledgeBase:
        name = clean_name(name, folder=False)
        kb = KnowledgeBase(
            id=kb_id or str(uuid.uuid4()),
            user_id=user_id,
            name=name,
            created_at=now,
            updated_at=now,
        )
        doc = {
            "_id": _key(user_id, kb.id),
            **kb.model_dump(by_alias=True),
            "nameKey": name_key(name),
        }
        try:
            await self._kbs.insert_one(doc)
        except DuplicateKeyError as err:
            if "nameKey" not in str(err):
                raise ConflictError("That collection already exists") from err
            raise ConflictError(
                f'You already have a collection named "{name}". Choose a different name.'
            ) from err
        return kb

    async def get(self, user_id: str, kb_id: str) -> KnowledgeBase | None:
        doc = await self._kbs.find_one({"_id": _key(user_id, kb_id)})
        return KnowledgeBase.model_validate(doc) if doc else None

    async def require(self, user_id: str, kb_id: str) -> KnowledgeBase:
        kb = await self.get(user_id, kb_id)
        if kb is None:
            raise NotFoundError("Collection not found")
        return kb

    async def list(self, user_id: str) -> list[KnowledgeBase]:
        cursor = self._kbs.find({"userId": user_id}).sort("nameKey", ASCENDING)
        return [KnowledgeBase.model_validate(d) async for d in cursor]

    async def rename(self, user_id: str, kb_id: str, name: str, now: datetime) -> KnowledgeBase:
        name = clean_name(name, folder=False)
        try:
            doc = await self._kbs.find_one_and_update(
                {"_id": _key(user_id, kb_id)},
                {"$set": {"name": name, "nameKey": name_key(name), "updatedAt": now}},
                return_document=True,
            )
        except DuplicateKeyError as err:
            raise ConflictError(
                f'You already have a collection named "{name}". Choose a different name.'
            ) from err
        if doc is None:
            raise NotFoundError("Collection not found")
        return KnowledgeBase.model_validate(doc)

    async def touch(self, user_id: str, kb_id: str, now: datetime) -> None:
        await self._kbs.update_one({"_id": _key(user_id, kb_id)}, {"$set": {"updatedAt": now}})

    async def delete(self, user_id: str, kb_id: str) -> None:
        await self._kbs.delete_one({"_id": _key(user_id, kb_id)})


class FolderStore:
    def __init__(self, db: AsyncDatabase[Doc]) -> None:
        self._folders = db["folders"]

    async def ensure_indexes(self) -> None:
        await self._folders.create_index(
            [
                ("userId", ASCENDING),
                ("kbId", ASCENDING),
                ("parentId", ASCENDING),
                ("nameKey", ASCENDING),
            ],
            unique=True,
        )

    async def get(self, user_id: str, folder_id: str) -> Folder | None:
        doc = await self._folders.find_one({"_id": folder_id, "userId": user_id})
        return Folder.model_validate(doc) if doc else None

    async def require(self, user_id: str, kb_id: str, folder_id: str) -> Folder:
        folder = await self.get(user_id, folder_id)
        if folder is None or folder.kb_id != kb_id:
            raise NotFoundError("Folder not found")
        return folder

    async def named(
        self, user_id: str, kb_id: str, parent_id: str | None, name: str
    ) -> Folder | None:
        doc = await self._folders.find_one(
            {"userId": user_id, "kbId": kb_id, "parentId": parent_id, "nameKey": name_key(name)}
        )
        return Folder.model_validate(doc) if doc else None

    async def create(
        self, user_id: str, kb_id: str, parent: Folder | None, name: str, now: datetime
    ) -> Folder:
        name = clean_name(name, folder=True)
        depth = (parent.depth if parent else 0) + 1
        if depth > MAX_FOLDER_DEPTH:
            raise ValidationError(f"Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep.")
        folder = Folder(
            _id=str(uuid.uuid4()),
            user_id=user_id,
            kb_id=kb_id,
            parent_id=parent.id if parent else None,
            name=name,
            depth=depth,
            created_at=now,
            updated_at=now,
        )
        try:
            await self._folders.insert_one(
                {**folder.model_dump(by_alias=True), "nameKey": name_key(name)}
            )
        except DuplicateKeyError as err:
            where = "this folder" if parent else "the collection"
            raise ConflictError(f"Folder '{name}' already exists in {where}") from err
        return folder

    async def ensure_path(
        self, user_id: str, kb_id: str, parent: Folder | None, parts: list[str], now: datetime
    ) -> Folder | None:
        """The folder at `parts` below `parent`, made where missing (a folder upload)."""
        for part in parts:
            found = await self.named(user_id, kb_id, parent.id if parent else None, part)
            if found is None:
                try:
                    found = await self.create(user_id, kb_id, parent, part, now)
                except ConflictError:
                    # Made meanwhile by another file of the same upload.
                    found = await self.named(user_id, kb_id, parent.id if parent else None, part)
                    assert found is not None
            parent = found
        return parent

    async def rename(self, user_id: str, folder: Folder, name: str, now: datetime) -> Folder:
        name = clean_name(name, folder=True)
        try:
            doc = await self._folders.find_one_and_update(
                {"_id": folder.id, "userId": user_id},
                {"$set": {"name": name, "nameKey": name_key(name), "updatedAt": now}},
                return_document=True,
            )
        except DuplicateKeyError as err:
            where = "this folder" if folder.parent_id else "the collection"
            raise ConflictError(f"Folder '{name}' already exists in {where}") from err
        if doc is None:
            raise NotFoundError("Folder not found")
        return Folder.model_validate(doc)

    async def children(self, user_id: str, kb_id: str, parent_id: str | None) -> list[Folder]:
        cursor = self._folders.find({"userId": user_id, "kbId": kb_id, "parentId": parent_id})
        return [Folder.model_validate(d) async for d in cursor.sort("nameKey", ASCENDING)]

    async def subtree(self, user_id: str, folder: Folder) -> list[Folder]:
        """The folder and every folder below it."""
        found, pending = [folder], [folder.id]
        while pending:
            cursor = self._folders.find({"userId": user_id, "parentId": {"$in": pending}})
            below = [Folder.model_validate(d) async for d in cursor]
            found += below
            pending = [f.id for f in below]
        return found

    async def path(self, user_id: str, folder: Folder) -> list[Folder]:
        """From the collection down to the folder."""
        chain = [folder]
        while chain[0].parent_id is not None:
            parent = await self.get(user_id, chain[0].parent_id)
            if parent is None:
                break
            chain.insert(0, parent)
        return chain

    async def delete(self, folder_ids: list[str]) -> None:
        await self._folders.delete_many({"_id": {"$in": folder_ids}})

    async def delete_kb(self, user_id: str, kb_id: str) -> None:
        await self._folders.delete_many({"userId": user_id, "kbId": kb_id})
