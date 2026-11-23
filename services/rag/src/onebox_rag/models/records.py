from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import Field

from onebox_rag.models.base import CamelModel


class SourceType(StrEnum):
    UPLOAD = "upload"
    MAIL = "mail"


class Status(StrEnum):
    """Outcomes: the same bytes give the same outcome, so only a new version
    of the file (or an explicit re-index) changes a terminal one."""

    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    # Read fine, but there was no text in it.
    EMPTY = "empty"
    FILE_TYPE_NOT_SUPPORTED = "file_type_not_supported"
    PASSWORD_PROTECTED = "password_protected"  # noqa: S105 - a status, not a secret
    # Unreadable, too big, a zip bomb, or parsing kept failing; `reason` says which.
    FAILED = "failed"


TERMINAL = frozenset(
    {
        Status.COMPLETED,
        Status.EMPTY,
        Status.FILE_TYPE_NOT_SUPPORTED,
        Status.PASSWORD_PROTECTED,
        Status.FAILED,
    }
)


class Stage(StrEnum):
    """Which step a queued or in-progress item is waiting on."""

    PARSE = "parse"
    INDEX = "index"


class Attachment(CamelModel):
    name: str
    mime_type: str
    content_id: str


class Content(CamelModel):
    """One set of bytes for one user (a virtual record): stored, parsed and indexed
    once however many records (emails, uploads, knowledge bases) hold it."""

    id: str = Field(alias="_id")
    user_id: str
    sha256: str
    mime_type: str
    size_bytes: int
    blob_key: str | None
    # Gzipped BlocksContainer JSON, once parsed.
    blocks_key: str | None = None
    block_count: int | None = None
    # Chosen once per revision and kept, so retries and re-indexes never re-decide.
    engine: str | None = None
    engine_reason: str | None = None
    # What inspection found (a PDF's pages, text layer, OCR share).
    facts: dict[str, Any] | None = None
    # Worker deaths (most likely out of memory) while parsing it: one retry, then it fails.
    worker_deaths: int = 0
    # The OCR provider that read it (scans and images), kept for retries like the engine.
    ocr_provider: str | None = None
    # Where it is indexed: the collection (one per embedding model) and how many points.
    index_collection: str | None = None
    embedding_model: str | None = None
    point_count: int | None = None
    revision: int = 1
    status: Status
    stage: Stage | None = Stage.PARSE
    reason: str | None = None
    # Files inside it (an email's attachments), each its own content.
    attachments: list[Attachment] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class Record(CamelModel):
    """One item in a source (an email, an attachment, an uploaded file) pointing at its content."""

    id: str = Field(alias="_id")
    user_id: str
    source_type: SourceType
    # The knowledge base for uploads, the mail account for mail.
    source_id: str
    # Stable id within the source (content hash for uploads, message or part id for mail).
    external_id: str
    parent_id: str | None = None
    content_id: str
    name: str
    declared_mime_type: str | None
    mime_type: str
    size_bytes: int
    sha256: str
    # Mirrors its content's, so lists and filters need no join.
    status: Status
    stage: Stage | None = Stage.PARSE
    reason: str | None = None
    created_at: datetime
    updated_at: datetime
