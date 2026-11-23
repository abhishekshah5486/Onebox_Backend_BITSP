from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile

from onebox_rag.auth import CurrentUser
from onebox_rag.errors import NotFoundError
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.ingestor import Ingestor, Source
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Record, SourceType, Status
from onebox_rag.pipeline.parse import decode_blocks

SOURCE_ID = r"^[A-Za-z0-9_-]{1,64}$"


def record_json(record: Record, **extra: Any) -> dict[str, Any]:
    body = record.model_dump(by_alias=True, mode="json")
    body["id"] = body.pop("_id")
    return {**body, **extra}


def rag_router() -> APIRouter:
    router = APIRouter(prefix="/rag")

    @router.post("/documents", status_code=201)
    async def upload(
        request: Request,
        user: CurrentUser,
        files: Annotated[list[UploadFile], File(min_length=1)],
        knowledge_base: Annotated[str, Form(alias="knowledgeBase", pattern=SOURCE_ID)] = "default",
    ) -> dict[str, list[dict[str, Any]]]:
        ingestor: Ingestor = request.app.state.ingestor
        results = []
        for upload in files:
            done = await ingestor.ingest(
                user_id=user.user_id,
                source=Source(SourceType.UPLOAD, knowledge_base),
                name=upload.filename or "untitled",
                declared_mime_type=upload.content_type,
                stream=upload.file,
            )
            results.append(record_json(done.record, duplicate=done.duplicate))
        return {"records": results}

    @router.get("/records")
    async def list_records(
        request: Request,
        user: CurrentUser,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        before: datetime | None = None,
        status: Status | None = None,
        source_type: Annotated[SourceType | None, Query(alias="sourceType")] = None,
        source_id: Annotated[str | None, Query(alias="sourceId", pattern=SOURCE_ID)] = None,
    ) -> dict[str, list[dict[str, Any]]]:
        records: RecordStore = request.app.state.records
        found = await records.find(
            user.user_id,
            limit=limit,
            before=before,
            status=status,
            sourceType=source_type,
            sourceId=source_id,
        )
        return {"records": [record_json(record) for record in found]}

    @router.get("/records/{record_id}")
    async def get_record(request: Request, user: CurrentUser, record_id: str) -> dict[str, Any]:
        records: RecordStore = request.app.state.records
        record = await records.get(user.user_id, record_id)
        if record is None:
            raise NotFoundError("Record not found")
        return record_json(record)

    @router.get("/records/{record_id}/blocks")
    async def get_blocks(request: Request, user: CurrentUser, record_id: str) -> dict[str, Any]:
        """The parsed blocks behind a record, as stored for indexing and citations."""
        records: RecordStore = request.app.state.records
        contents: ContentStore = request.app.state.contents
        blobs: BlobStore = request.app.state.blobs
        record = await records.get(user.user_id, record_id)
        content = await contents.get(record.content_id) if record else None
        if content is None or content.blocks_key is None:
            raise NotFoundError("No parsed blocks for this record")
        container = decode_blocks(await blobs.get(content.blocks_key))
        return {
            "engine": content.engine,
            **container.model_dump(by_alias=True, mode="json", exclude_none=True),
        }

    @router.delete("/records/{record_id}", status_code=204)
    async def delete_record(request: Request, user: CurrentUser, record_id: str) -> Response:
        ingestor: Ingestor = request.app.state.ingestor
        if not await ingestor.delete(user.user_id, record_id):
            raise NotFoundError("Record not found")
        return Response(status_code=204)

    return router
