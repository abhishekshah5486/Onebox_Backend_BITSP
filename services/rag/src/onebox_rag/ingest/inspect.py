"""What a file really is, and whether it is safe to parse, judged from its bytes."""

import mimetypes
import zipfile
from dataclasses import dataclass
from typing import BinaryIO
from xml.etree.ElementTree import Element

import msoffcrypto
import puremagic
from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from onebox_rag.models import Status

ZIP = "application/zip"
PDF = "application/pdf"
# Compound (OLE) files: legacy Office, and OOXML saved with a password.
OLE_MAGIC = bytes.fromhex("D0CF11E0A1B11AE1")
OCTET = "application/octet-stream"
# OOXML names its main part's type in [Content_Types].xml; the file's type is that minus this.
_OOXML_MAIN = ".main+xml"
_CONTENT_TYPES_NS = "{http://schemas.openxmlformats.org/package/2006/content-types}"
_ODF_MANIFEST = "META-INF/manifest.xml"
_ODF_ENCRYPTION = "{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}encryption-data"
# Index files bigger than this are not what a real package carries; skip rather than read them.
_MAX_INDEX_BYTES = 2**20
_SNIFF_BYTES = 64 * 1024


@dataclass(frozen=True)
class Limits:
    max_bytes: int
    max_unzipped_bytes: int
    max_zip_ratio: int
    max_zip_entries: int


@dataclass(frozen=True)
class Rejection:
    status: Status
    reason: str


PASSWORD_PROTECTED = Rejection(Status.PASSWORD_PROTECTED, "password-protected")


@dataclass(frozen=True)
class Inspection:
    mime_type: str
    # Why the file won't be parsed, or None when it is fine.
    rejection: Rejection | None = None


def inspect_file(
    stream: BinaryIO, size: int, name: str, declared: str | None, limits: Limits
) -> Inspection:
    mime = detect_type(stream, name, declared)
    if size > limits.max_bytes:
        return Inspection(
            mime, Rejection(Status.FAILED, f"larger than {limits.max_bytes // 2**20} MB")
        )
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
        return _best(found, name, declared)
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
            root = _xml(archive, "[Content_Types].xml")
            for override in [] if root is None else root.iter(f"{_CONTENT_TYPES_NS}Override"):
                content_type = str(override.get("ContentType", ""))
                if content_type.endswith(_OOXML_MAIN):
                    return content_type.removesuffix(_OOXML_MAIN)
    return ZIP


def _xml(archive: zipfile.ZipFile, name: str) -> Element | None:
    """A package index, parsed without entities, DTDs or network access."""
    try:
        if archive.getinfo(name).file_size > _MAX_INDEX_BYTES:
            return None
        return ElementTree.fromstring(archive.read(name))
    except (KeyError, ElementTree.ParseError, DefusedXmlException, zipfile.BadZipFile):
        return None


def _is_text(head: bytes) -> bool:
    if b"\0" in head:
        return False
    try:
        # A multi-byte character may be cut at the end of the sample.
        head.decode("utf-8")
    except UnicodeDecodeError as err:
        return err.start >= len(head) - 3
    return True


def _best(found: list[puremagic.PureMagicWithConfidence], name: str, declared: str | None) -> str:
    """The most confident match; on a tie, the one of the kind the name or the sender gives
    (HEIC and MP4 share a container and score alike)."""
    tied = [m for m in found if m.mime_type and m.confidence == found[0].confidence]
    hints = [h for h in (mimetypes.guess_type(name, strict=False)[0], declared) if h]
    for hint in hints:
        for match in tied:
            if match.mime_type == hint:
                return str(match.mime_type)
    for hint in hints:
        for match in tied:
            if match.mime_type.split("/")[0] == hint.split("/")[0]:
                return str(match.mime_type)
    return str(found[0].mime_type)


def _guess(name: str, declared: str | None, fallback: str) -> str:
    guessed, _ = mimetypes.guess_type(name, strict=False)
    if guessed:
        return guessed
    if declared and declared != OCTET:
        return declared
    return fallback


def _rejection(stream: BinaryIO, mime: str, limits: Limits) -> Rejection | None:
    stream.seek(0)
    try:
        if zipfile.is_zipfile(stream):
            stream.seek(0)
            return _zip_rejection(stream, limits)
        stream.seek(0)
        if mime == PDF:
            return _pdf_rejection(stream)
        stream.seek(0)
        if stream.read(len(OLE_MAGIC)) == OLE_MAGIC:
            stream.seek(0)
            return _office_rejection(stream)
        return None
    finally:
        stream.seek(0)


def _zip_rejection(stream: BinaryIO, limits: Limits) -> Rejection | None:
    try:
        with zipfile.ZipFile(stream) as archive:
            entries = archive.infolist()
            if len(entries) > limits.max_zip_entries:
                return Rejection(
                    Status.FAILED, f"more than {limits.max_zip_entries} entries (zip bomb)"
                )
            unpacked = sum(entry.file_size for entry in entries)
            packed = sum(entry.compress_size for entry in entries)
            if unpacked > limits.max_unzipped_bytes:
                mb = limits.max_unzipped_bytes // 2**20
                return Rejection(Status.FAILED, f"unpacks to more than {mb} MB (zip bomb)")
            if packed and unpacked / packed > limits.max_zip_ratio:
                ratio = limits.max_zip_ratio
                return Rejection(Status.FAILED, f"compressed more than {ratio}:1 (zip bomb)")
            if any(entry.flag_bits & 0x1 for entry in entries):
                return PASSWORD_PROTECTED
            # OpenDocument keeps its zip and lists encryption-data in its manifest.
            manifest = _xml(archive, _ODF_MANIFEST)
            if manifest is not None and next(manifest.iter(_ODF_ENCRYPTION), None) is not None:
                return PASSWORD_PROTECTED
    except zipfile.BadZipFile:
        return Rejection(Status.FAILED, "damaged archive")
    return None


def _pdf_rejection(stream: BinaryIO) -> Rejection | None:
    try:
        reader = PdfReader(stream)
        # Many PDFs are "encrypted" with an empty password only to restrict printing; those open.
        if reader.is_encrypted and not reader.decrypt(""):
            return PASSWORD_PROTECTED
    except PdfReadError:
        # Damaged PDFs still go to the parsers, which recover what they can.
        return None
    return None


def _office_rejection(stream: BinaryIO) -> Rejection | None:
    # A password turns DOCX, XLSX and PPTX into a compound file; msoffcrypto reads its flags,
    # and those of legacy .doc, .xls and .ppt (otherwise they would only fail in the parser).
    try:
        if msoffcrypto.OfficeFile(stream).is_encrypted():
            return PASSWORD_PROTECTED
    except Exception:
        return None
    return None
