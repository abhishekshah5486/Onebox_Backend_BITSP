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


class DeleteSource(StrEnum):
    """Who sent a record to the trash: the user (it stays there whatever its source does)
    or its source (it comes back if the source has it again)."""

    USER = "user"
    SOURCE = "source"


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


class ClassifyStatus(StrEnum):
    """Where a content's summary and classification stand (after it is searchable)."""

    QUEUED = "queued"
    # Waits until a search first returns it.
    DEFERRED = "deferred"
    COMPLETED = "completed"
    # Not asked: switched off, a .log or .cfg file, or no text to read.
    SKIPPED = "skipped"
    FAILED = "failed"


class Subcategories(CamelModel):
    level1: str = ""
    level2: str = ""
    level3: str = ""


class Classification(CamelModel):
    """What a model says a content is; None lists mean unknown (only a summary came back)."""

    summary: str
    category: str | None = None
    subcategories: Subcategories | None = None
    languages: list[str] | None = None
    topics: list[str] | None = None
    organizations: list[str] | None = None


class EmbedMarker(CamelModel):
    """Written before an index run's first point, cleared when it completes: a retry of the
    same revision with the same setup and the same points keeps those that exist."""

    revision: int
    collection: str
    # The embedding setup (dense model, its size, the sparse model).
    key: str
    # Of the sorted ids of the points the revision needs, and how many that is.
    digest: str
    total: int


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
    # Its bytes are in the blob store. Until they are, the next attempt with the same bytes
    # stores them; the content is never deleted, since another record may already hold it.
    stored: bool = True
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
    # Its points carry its records' dates (and emails' header points are written).
    points_dated: bool = False
    # Its points were removed while every record holding it was in the trash; a restore
    # indexes it again from its stored blocks.
    unindexed: bool = False
    # A permanent delete owes its cleanup (points, files, jobs); the sweep finishes one that
    # was cut short.
    collect_pending: bool = False
    embed_marker: EmbedMarker | None = None
    classification: Classification | None = None
    classify_status: ClassifyStatus | None = None
    classify_reason: str | None = None
    # The revision the classification was made from.
    classified_revision: int | None = None
    revision: int = 1
    status: Status
    stage: Stage | None = Stage.PARSE
    reason: str | None = None
    # Files inside it (an email's attachments), each its own content.
    attachments: list[Attachment] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class Address(CamelModel):
    name: str = ""
    address: str


class MailInfo(CamelModel):
    """An email record's place in the mailbox: the copies (one per folder) it is read from and
    who sent it to whom, for citations and for the model's context."""

    key: str
    # The copies it is read from (not in spam, trash or drafts).
    copy_ids: list[str]
    # Every copy the mailbox holds, those included: the email is gone once none is left.
    held_ids: list[str] = Field(default_factory=list)
    version: int
    thread_id: str | None = None
    message_id_header: str | None = None
    sender: Address | None = None
    to: list[Address] = Field(default_factory=list)
    cc: list[Address] = Field(default_factory=list)
    received_at: datetime | None = None
    # Files sent with it (pictures inline in the body too), named in its header point.
    attachment_names: list[str] = Field(default_factory=list)
    # Every attachment has its record (one that failed to download is tried again).
    attachments_done: bool = False


class DateOrigin(StrEnum):
    """Where a record's created and modified dates came from."""

    SOURCE = "source"  # the source's own (an email's: when it was received)
    LAST_MODIFIED = "lastModified"  # an upload: the file's last-modified time, from the browser
    UPLOAD = "upload"  # an upload sent without one: when it was uploaded
    CONTENT = "content"  # an upload: the dates its header states


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
    mail: MailInfo | None = None
    # What date filters read: when the item was written (an email received, a file uploaded)
    # and last changed in its source. Set on every new record.
    source_created_at: datetime | None = None
    source_modified_at: datetime | None = None
    date_origin: DateOrigin = DateOrigin.SOURCE
    # What the upload gave, kept while its content's dates stand in, so they can be put back.
    upload_created_at: datetime | None = None
    upload_modified_at: datetime | None = None
    upload_date_origin: DateOrigin | None = None
    # Its title point is written (cleared to have the sweep write it again).
    titled: bool = False
    # The folder of its collection it sits in; None at the collection's top.
    folder_id: str | None = None
    # When it went to the trash; it is left out of lists and searches until restored.
    deleted_at: datetime | None = None
    delete_source: DeleteSource | None = None
    # Shared by everything one delete sent to the trash, so a restore brings back that set.
    delete_batch_id: str | None = None
    # Bumped when its file is replaced.
    version: int = 1

    @property
    def record_type(self) -> str:
        return "MAIL" if self.source_type == SourceType.MAIL and self.parent_id is None else "FILE"

    @property
    def origin(self) -> str:
        return "UPLOAD" if self.source_type == SourceType.UPLOAD else "CONNECTOR"

    def dates(self) -> tuple[datetime, datetime]:
        created = self.source_created_at or self.created_at
        return created, self.source_modified_at or created
