from dataclasses import dataclass, field

from onebox_rag.models.blocks import BlocksContainer


@dataclass(frozen=True)
class ExtractedFile:
    """A file found inside another (an email's attachment), ingested as its own record."""

    name: str
    mime_type: str | None
    data: bytes


@dataclass
class ParseResult:
    container: BlocksContainer
    attachments: list[ExtractedFile] = field(default_factory=list)


class UnreadableFileError(Exception):
    """The file is damaged or not what it claims; retrying will not help."""


class ProtectedFileError(UnreadableFileError):
    """Locked by a password or DRM; reported as password-protected."""
