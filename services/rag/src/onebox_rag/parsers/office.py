"""Formats the Docling engine reads, and the legacy ones LibreOffice converts first."""

from dataclasses import dataclass

OOXML = "application/vnd.openxmlformats-officedocument"


@dataclass(frozen=True)
class OfficeFormat:
    # What Docling is handed: "pdf", "docx" or "pptx".
    docling: str
    # Set for formats LibreOffice converts to `docling` first.
    legacy_ext: str | None = None


OFFICE_FORMATS = {
    "application/pdf": OfficeFormat("pdf"),
    f"{OOXML}.wordprocessingml.document": OfficeFormat("docx"),
    f"{OOXML}.presentationml.presentation": OfficeFormat("pptx"),
    "application/msword": OfficeFormat("docx", "doc"),
    "application/rtf": OfficeFormat("docx", "rtf"),
    "text/rtf": OfficeFormat("docx", "rtf"),
    "application/vnd.oasis.opendocument.text": OfficeFormat("docx", "odt"),
    "application/vnd.ms-powerpoint": OfficeFormat("pptx", "ppt"),
    "application/vnd.oasis.opendocument.presentation": OfficeFormat("pptx", "odp"),
}


def office_format(mime_type: str) -> OfficeFormat | None:
    return OFFICE_FORMATS.get(mime_type.split(";")[0].strip().lower())
