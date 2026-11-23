from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _Model(BaseModel):
    # camelCase in MongoDB and JSON, like the TypeScript services' documents.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class SourceType(StrEnum):
    UPLOAD = "upload"
    MAIL = "mail"


class RecordStatus(StrEnum):
    QUEUED = "queued"
    PARSING = "parsing"
    INDEXING = "indexing"
    READY = "ready"
    FAILED = "failed"
    # Never stored or parsed: too big, a zip bomb, or encrypted.
    REJECTED = "rejected"


class Record(_Model):
    """One ingested item (an email, an attachment, an uploaded file), parsed into blocks."""

    id: str = Field(alias="_id")
    user_id: str
    source_type: SourceType
    # The knowledge base for uploads, the mail account for mail.
    source_id: str
    # Stable id within the source (content hash for uploads, message or part id for mail).
    external_id: str
    parent_id: str | None = None
    name: str
    declared_mime_type: str | None
    mime_type: str
    size_bytes: int
    sha256: str
    blob_key: str | None
    revision: int = 1
    status: RecordStatus
    reason: str | None = None
    created_at: datetime
    updated_at: datetime


class BlockType(StrEnum):
    TEXT = "text"
    HEADING = "heading"
    LIST_ITEM = "list_item"
    CODE = "code"
    TABLE = "table"
    TABLE_ROW = "table_row"
    IMAGE = "image"
    CAPTION = "caption"
    SUMMARY = "summary"


class Block(_Model):
    """The unit parsers produce and citations point at, whatever the source format."""

    id: str
    type: BlockType
    text: str
    page: int | None = None
    # Headings above this block, outermost first, so a chunk keeps its context.
    heading_path: list[str] = Field(default_factory=list)
    # [x0, y0, x1, y1] in page points, when the parser knows the layout.
    bbox: tuple[float, float, float, float] | None = None
    # The table a row belongs to, the image a caption describes, and so on.
    parent_id: str | None = None
    # Format-specific extras: table cells, image blob keys, OCR confidence.
    data: dict[str, Any] = Field(default_factory=dict)


class ParsedDocument(_Model):
    record_id: str
    revision: int
    # The engine chosen for this revision, kept so retries and re-indexes never re-decide.
    engine: str
    blocks: list[Block]
