from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Query, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from onebox_rag.auth import CurrentUser, require_internal
from onebox_rag.dates import parse_bounds
from onebox_rag.errors import NotFoundError, UnavailableError
from onebox_rag.index.embed import EmbeddingUnavailableError
from onebox_rag.index.qdrant_store import SearchIndexError
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.ingestor import Ingestor, Source
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Record, SourceType, Status
from onebox_rag.pipeline.parse import decode_blocks
from onebox_rag.retrieval.read import FocusSettings, focused_read, read_page
from onebox_rag.retrieval.service import Retriever, Scope

SOURCE_ID = r"^[A-Za-z0-9_-]{1,64}$"
DEFAULT_RETRIEVE_LIMIT, MAX_RETRIEVE_LIMIT = 8, 50


INDEX_TIMEOUT = (
    "The search index took too long to respond, so no results are shown. Try again in a minute."
)
INDEX_UNREACHABLE = (
    "The search index can't be reached just now, so no results are shown. Try again in a minute."
)


class RetrieveQuery(BaseModel):
    """A question over the user's records, optionally within some sources or records."""

    model_config = ConfigDict(populate_by_name=True)

    query: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=DEFAULT_RETRIEVE_LIMIT, ge=1, le=MAX_RETRIEVE_LIMIT)
    source_ids: list[str] | None = Field(default=None, alias="sourceIds", max_length=100)
    source_types: list[SourceType] | None = Field(default=None, alias="sourceTypes")
    record_ids: list[str] | None = Field(default=None, alias="recordIds", max_length=1000)
    max_chunks_per_record: int | None = Field(
        default=None, alias="maxChunksPerRecord", ge=1, le=MAX_RETRIEVE_LIMIT
    )
    # YYYY-MM-DD (the whole day) or a datetime with its zone; an email's dates are when it
    # was received, an upload's when it was uploaded.
    created_after: str | None = Field(default=None, alias="createdAfter", max_length=64)
    created_before: str | None = Field(default=None, alias="createdBefore", max_length=64)
    modified_after: str | None = Field(default=None, alias="modifiedAfter", max_length=64)
    modified_before: str | None = Field(default=None, alias="modifiedBefore", max_length=64)


class InternalRetrieveQuery(RetrieveQuery):
    user_id: str = Field(alias="userId", min_length=1)


async def _retrieve(request: Request, user_id: str, body: RetrieveQuery) -> dict[str, Any]:
    retriever: Retriever | None = getattr(request.app.state, "retriever", None)
    if retriever is None:
        raise UnavailableError("Retrieval needs Qdrant and llm-proxy")
    scope = Scope(
        body.source_ids,
        [str(t) for t in body.source_types] if body.source_types is not None else None,
        body.record_ids,
    )
    dates = parse_bounds(
        created_after=body.created_after,
        created_before=body.created_before,
        modified_after=body.modified_after,
        modified_before=body.modified_before,
    )
    try:
        found = await retriever.retrieve(
            user_id,
            body.query,
            limit=body.limit,
            scope=scope,
            max_per_record=body.max_chunks_per_record,
            dates=dates,
        )
    except EmbeddingUnavailableError as err:
        raise UnavailableError("The embedding model is unavailable") from err
    except SearchIndexError as err:
        # Never an empty result: "nothing found" would read as "there is nothing".
        if err.timed_out:
            raise UnavailableError(INDEX_TIMEOUT, code="SEARCH_INDEX_TIMEOUT") from err
        raise UnavailableError(INDEX_UNREACHABLE, code="SEARCH_INDEX_UNREACHABLE") from err
    out: dict[str, Any] = {"chunks": found.chunks, "unindexed": found.unindexed}
    if found.incomplete:
        out["incomplete"] = found.incomplete
    if found.notices:
        out["notices"] = found.notices
    return out


async def _read(
    request: Request,
    user_id: str,
    record_id: str,
    start: int,
    max_blocks: int | None,
    query: str | None = None,
) -> dict[str, Any]:
    records: RecordStore = request.app.state.records
    contents: ContentStore = request.app.state.contents
    blobs: BlobStore = request.app.state.blobs
    record = await records.get(user_id, record_id)
    content = await contents.get(record.content_id) if record else None
    if record is None or content is None or content.blocks_key is None:
        raise NotFoundError("No parsed blocks for this record")
    container = decode_blocks(await blobs.get(content.blocks_key))
    settings = request.app.state.settings
    head = {"recordId": record.id, "name": record.name, "mimeType": record.mime_type}
    retriever: Retriever | None = getattr(request.app.state, "retriever", None)
    # With a question, from the start: the part that answers it (a continuation reads in order).
    if query and query.strip() and start == 0 and retriever is not None:
        try:
            matches = await retriever.matching_blocks(user_id, content, query)
        except (EmbeddingUnavailableError, SearchIndexError):
            # The record is still readable; it is read in order instead.
            matches = []
        focus = FocusSettings(max_chars=settings.RAG_FOCUSED_READ_CHARS)
        focused = focused_read(container, matches, focus)
        if focused is not None:
            return {**head, **focused, "focused": True}
    size = max_blocks or settings.RAG_READ_MAX_BLOCKS
    return {**head, **read_page(container, start, size)}


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

    @router.post("/retrieve")
    async def retrieve(request: Request, user: CurrentUser, body: RetrieveQuery) -> dict[str, Any]:
        return await _retrieve(request, user.user_id, body)

    @router.get("/records/{record_id}/read")
    async def read(
        request: Request,
        user: CurrentUser,
        record_id: str,
        start: Annotated[int, Query(ge=0)] = 0,
        max_blocks: Annotated[int | None, Query(alias="max", ge=1, le=5000)] = None,
        query: Annotated[str | None, Query(max_length=1000)] = None,
    ) -> dict[str, Any]:
        """The record's blocks in order, a page at a time; `next` is where to continue. With a
        `query`, a record too long to read whole gives the part that answers it, `gaps` naming
        what was left out."""
        return await _read(request, user.user_id, record_id, start, max_blocks, query)

    @router.delete("/records/{record_id}", status_code=204)
    async def delete_record(request: Request, user: CurrentUser, record_id: str) -> Response:
        ingestor: Ingestor = request.app.state.ingestor
        if not await ingestor.delete(user.user_id, record_id):
            raise NotFoundError("Record not found")
        return Response(status_code=204)

    return router


def internal_router() -> APIRouter:
    """The same reads for other OneBox services (the agent service), for a named user."""
    router = APIRouter(prefix="/internal/rag", dependencies=[Depends(require_internal)])

    @router.post("/retrieve")
    async def retrieve(request: Request, body: InternalRetrieveQuery) -> dict[str, Any]:
        return await _retrieve(request, body.user_id, body)

    @router.get("/records/{record_id}/read")
    async def read(
        request: Request,
        record_id: str,
        user_id: Annotated[str, Query(alias="userId", min_length=1)],
        start: Annotated[int, Query(ge=0)] = 0,
        max_blocks: Annotated[int | None, Query(alias="max", ge=1, le=5000)] = None,
        query: Annotated[str | None, Query(max_length=1000)] = None,
    ) -> dict[str, Any]:
        return await _read(request, user_id, record_id, start, max_blocks, query)

    return router
