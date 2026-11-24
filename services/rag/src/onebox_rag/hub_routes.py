"""Collections, their folders, and where records sit in them (names, moves, the trash)."""

from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import Field

from onebox_rag.auth import CurrentUser
from onebox_rag.errors import NotFoundError
from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.organize import Organizer
from onebox_rag.models.base import CamelModel
from onebox_rag.models.hub import Folder, KnowledgeBase
from onebox_rag.routes import record_json


class NameBody(CamelModel):
    name: str = Field(min_length=1, max_length=255)


class FolderBody(NameBody):
    parent_id: str | None = None


class MoveBody(CamelModel):
    collection_id: str
    # None: the top of the collection.
    folder_id: str | None = None


class IdsBody(CamelModel):
    ids: list[str] = Field(min_length=1, max_length=100)


def kb_json(kb: KnowledgeBase) -> dict[str, Any]:
    return kb.model_dump(by_alias=True, mode="json", exclude={"user_id"})


def folder_json(folder: Folder) -> dict[str, Any]:
    body = folder.model_dump(by_alias=True, mode="json", exclude={"user_id"})
    body["id"] = body.pop("_id")
    body["collectionId"] = body.pop("kbId")
    return body


def _organizer(request: Request) -> Organizer:
    organizer: Organizer = request.app.state.organizer
    return organizer


def hub_router() -> APIRouter:
    router = APIRouter(prefix="/rag")

    @router.get("/collections")
    async def list_collections(request: Request, user: CurrentUser) -> dict[str, Any]:
        kbs = await _organizer(request).kbs.list(user.user_id)
        return {"collections": [kb_json(kb) for kb in kbs]}

    @router.post("/collections", status_code=201)
    async def create_collection(
        request: Request, user: CurrentUser, body: NameBody
    ) -> dict[str, Any]:
        organizer = _organizer(request)
        kb = await organizer.kbs.create(user.user_id, body.name, organizer.now())
        return kb_json(kb)

    @router.patch("/collections/{kb_id}")
    async def rename_collection(
        request: Request, user: CurrentUser, kb_id: str, body: NameBody
    ) -> dict[str, Any]:
        organizer = _organizer(request)
        kb = await organizer.kbs.rename(user.user_id, kb_id, body.name, organizer.now())
        return kb_json(kb)

    @router.delete("/collections/{kb_id}", status_code=204)
    async def delete_collection(request: Request, user: CurrentUser, kb_id: str) -> None:
        await _organizer(request).delete_kb(user.user_id, kb_id)

    @router.post("/collections/{kb_id}/folders", status_code=201)
    async def create_folder(
        request: Request, user: CurrentUser, kb_id: str, body: FolderBody
    ) -> dict[str, Any]:
        folder = await _organizer(request).create_folder(
            user.user_id, kb_id, body.parent_id, body.name
        )
        return folder_json(folder)

    @router.patch("/collections/{kb_id}/folders/{folder_id}")
    async def rename_folder(
        request: Request, user: CurrentUser, kb_id: str, folder_id: str, body: NameBody
    ) -> dict[str, Any]:
        folder = await _organizer(request).rename_folder(user.user_id, kb_id, folder_id, body.name)
        return folder_json(folder)

    @router.delete("/collections/{kb_id}/folders/{folder_id}")
    async def delete_folder(
        request: Request, user: CurrentUser, kb_id: str, folder_id: str
    ) -> dict[str, Any]:
        trashed = await _organizer(request).delete_folder(user.user_id, kb_id, folder_id)
        return {"trashed": trashed}

    @router.patch("/records/{record_id}")
    async def rename_record(
        request: Request, user: CurrentUser, record_id: str, body: NameBody
    ) -> dict[str, Any]:
        return record_json(
            await _organizer(request).rename_record(user.user_id, record_id, body.name)
        )

    @router.post("/records/{record_id}/move")
    async def move_record(
        request: Request, user: CurrentUser, record_id: str, body: MoveBody
    ) -> dict[str, Any]:
        record = await _organizer(request).move_record(
            user.user_id, body.collection_id, record_id, body.folder_id
        )
        return record_json(record)

    @router.post("/records/trash")
    async def trash_records(request: Request, user: CurrentUser, body: IdsBody) -> dict[str, Any]:
        return {"trashed": await _organizer(request).trash(user.user_id, body.ids)}

    @router.post("/records/restore")
    async def restore_records(request: Request, user: CurrentUser, body: IdsBody) -> dict[str, Any]:
        return {"restored": await _organizer(request).restore(user.user_id, body.ids)}

    @router.delete("/records/{record_id}", status_code=204)
    async def delete_record(
        request: Request,
        user: CurrentUser,
        record_id: str,
        permanent: bool = Query(default=False),
    ) -> None:
        """To the trash, or (permanent) gone for good with its search index entries."""
        if permanent:
            ingestor: Ingestor = request.app.state.ingestor
            if not await ingestor.delete(user.user_id, record_id):
                raise NotFoundError("Record not found")
        elif not await _organizer(request).trash(user.user_id, [record_id]):
            raise NotFoundError("Record not found")

    return router
