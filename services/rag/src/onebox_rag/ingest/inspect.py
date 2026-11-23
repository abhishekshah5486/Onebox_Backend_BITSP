"""What a file really is, and whether it is safe to parse, judged from its bytes."""

import mimetypes
import zipfile
from dataclasses import dataclass
from typing import BinaryIO
from xml.etree import ElementTree

import msoffcrypto
import puremagic
from pypdf import PdfReader
from pypdf.errors import PdfReadError

ZIP = "application/zip"
PDF = "application/pdf"
OLE = "application/x-ole-storage"
OCTET = "application/octet-stream"
# OOXML names its main part's type in [Content_Types].xml; the file's type is that minus this.
_OOXML_MAIN = ".main+xml"
_CONTENT_TYPES_NS = "{http://schemas.openxmlformats.org/package/2006/content-types}"
_SNIFF_BYTES = 64 * 1024


@dataclass(frozen=True)
class Limits:
    max_bytes: int
    max_unzipped_bytes: int
    max_zip_ratio: int
    max_zip_entries: int


@dataclass(frozen=True)
class Inspection:
    mime_type: str
    # Why the file won't be parsed, or None when it is fine.
    rejection: str | None = None


def inspect_file(
    stream: BinaryIO, size: int, name: str, declared: str | None, limits: Limits
) -> Inspection:
    mime = detect_type(stream, name, declared)
    if size > limits.max_bytes:
        return Inspection(mime, f"larger than {limits.max_bytes // 2**20} MB")
    return Inspection(mime, _rejection(stream, mime, limits))


def detect_type(stream: BinaryIO, name: str, declared: str | None) -> str:
    """Magic bytes first; ZIP and OLE containers by their contents; text by its name."""
    stream.seek(0)
    head = stream.read(_SNIFF_BYTES)
    stream.seek(0)
    if zipfile.is_zipfile(stream):
        stream.seek(0)
        return _zip_type(stream)
    stream.seek(0)
    if not head:
        return _guess(name, declared, "text/plain")
    try:
        found = puremagic.magic_string(head, filename=name)
    except puremagic.PureError:
        found = []
    if found and found[0].mime_type and found[0].confidence >= 0.5:
        return str(found[0].mime_type)
    if _is_text(head):
        return _guess(name, declared, "text/plain")
    if found and found[0].mime_type:
        return str(found[0].mime_type)
    return _guess(name, declared, OCTET)


def _zip_type(stream: BinaryIO) -> str:
    with zipfile.ZipFile(stream) as archive:
        names = set(archive.namelist())
        # EPUB and OpenDocument store their type, uncompressed, in a "mimetype" entry.
        if "mimetype" in names:
            declared = archive.read("mimetype").decode("ascii", "replace").strip()
            if "/" in declared:
                return declared
        if "[Content_Types].xml" in names:
            root = ElementTree.fromstring(archive.read("[Content_Types].xml"))  # noqa: S314
            for override in root.iter(f"{_CONTENT_TYPES_NS}Override"):
                content_type = override.get("ContentType", "")
                if content_type.endswith(_OOXML_MAIN):
                    return content_type.removesuffix(_OOXML_MAIN)
    return ZIP


def _is_text(head: bytes) -> bool:
    if b"\0" in head:
        return False
    try:
        # A multi-byte character may be cut at the end of the sample.
        head.decode("utf-8")
    except UnicodeDecodeError as err:
        return err.start >= len(head) - 3
    return True


def _guess(name: str, declared: str | None, fallback: str) -> str:
    guessed, _ = mimetypes.guess_type(name, strict=False)
    if guessed:
        return guessed
    if declared and declared != OCTET:
        return declared
    return fallback


def _rejection(stream: BinaryIO, mime: str, limits: Limits) -> str | None:
    stream.seek(0)
    try:
        if zipfile.is_zipfile(stream):
            stream.seek(0)
            return _zip_rejection(stream, limits)
        stream.seek(0)
        if mime == PDF:
            return _pdf_rejection(stream)
        if mime == OLE or mime.startswith("application/vnd.ms-") or mime == "application/msword":
            return _office_rejection(stream)
        return None
    finally:
        stream.seek(0)


def _zip_rejection(stream: BinaryIO, limits: Limits) -> str | None:
    try:
        with zipfile.ZipFile(stream) as archive:
            entries = archive.infolist()
    except zipfile.BadZipFile:
        return "damaged archive"
    if len(entries) > limits.max_zip_entries:
        return f"more than {limits.max_zip_entries} entries (zip bomb)"
    if any(entry.flag_bits & 0x1 for entry in entries):
        return "encrypted"
    unpacked = sum(entry.file_size for entry in entries)
    packed = sum(entry.compress_size for entry in entries)
    if unpacked > limits.max_unzipped_bytes:
        return f"unpacks to more than {limits.max_unzipped_bytes // 2**20} MB (zip bomb)"
    if packed and unpacked / packed > limits.max_zip_ratio:
        return f"compressed more than {limits.max_zip_ratio}:1 (zip bomb)"
    return None


def _pdf_rejection(stream: BinaryIO) -> str | None:
    try:
        reader = PdfReader(stream)
        # Many PDFs are "encrypted" with an empty password only to restrict printing; those open.
        if reader.is_encrypted and not reader.decrypt(""):
            return "encrypted"
    except PdfReadError:
        # Damaged PDFs still go to the parsers, which recover what they can.
        return None
    return None


def _office_rejection(stream: BinaryIO) -> str | None:
    try:
        if msoffcrypto.OfficeFile(stream).is_encrypted():
            return "encrypted"
    except Exception:
        return None
    return None
