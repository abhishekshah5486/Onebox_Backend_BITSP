import io
import zipfile

import pytest
from msoffcrypto.format.ooxml import OOXMLFile
from pypdf import PdfWriter

from onebox_rag.ingest.inspect import Limits, inspect_file
from onebox_rag.models import Status

LIMITS = Limits(
    max_bytes=10 * 2**20, max_unzipped_bytes=50 * 2**20, max_zip_ratio=100, max_zip_entries=1000
)
OOXML = "application/vnd.openxmlformats-officedocument"


def archive(files: dict[str, bytes], *, encrypted: bool = False) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)
    if not encrypted:
        return out.getvalue()
    # zipfile can't encrypt, so set the "encrypted" bit in the local and central headers.
    raw = bytearray(out.getvalue())
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        at = raw.find(signature)
        while at != -1:
            raw[at + flag_offset] |= 0x1
            at = raw.find(signature, at + 4)
    return bytes(raw)


def ooxml(main_type: str) -> bytes:
    types = (
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        f'<Override PartName="/main.xml" ContentType="{main_type}.main+xml"/></Types>'
    )
    return archive({"[Content_Types].xml": types.encode(), "main.xml": b"<x/>"})


def pdf(password: str | None = None) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    if password is not None:
        writer.encrypt(user_password=password, owner_password="owner")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def check(data: bytes, name: str, declared: str | None = None) -> tuple[str, str | None]:
    found = inspect_file(io.BytesIO(data), len(data), name, declared, LIMITS)
    return found.mime_type, found.rejection.reason if found.rejection else None


@pytest.mark.parametrize(
    ("data", "name", "expected"),
    [
        (
            ooxml(f"{OOXML}.wordprocessingml.document"),
            "a.zip",
            f"{OOXML}.wordprocessingml.document",
        ),
        (ooxml(f"{OOXML}.spreadsheetml.sheet"), "a.docx", f"{OOXML}.spreadsheetml.sheet"),
        (
            ooxml(f"{OOXML}.presentationml.presentation"),
            "a",
            f"{OOXML}.presentationml.presentation",
        ),
        (archive({"mimetype": b"application/epub+zip"}), "book", "application/epub+zip"),
        (pdf(), "scan.png", "application/pdf"),
        (b"\x89PNG\r\n\x1a\n" + b"\0" * 64, "report.pdf", "image/png"),
        (b"name,amount\nrent,1200\n", "q3.csv", "text/csv"),
        (b"# Notes\n\nplain text", "notes.md", "text/markdown"),
        (b"From: a@b.co\r\nSubject: hi\r\n\r\nbody", "mail.eml", "message/rfc822"),
    ],
    ids=["docx", "xlsx", "pptx", "epub", "pdf", "png", "csv", "markdown", "eml"],
)
def test_knows_the_type_from_the_bytes_not_the_name(data: bytes, name: str, expected: str) -> None:
    assert check(data, name) == (expected, None)


def encrypted_ooxml() -> bytes:
    out = io.BytesIO()
    OOXMLFile(io.BytesIO(ooxml(f"{OOXML}.wordprocessingml.document"))).encrypt("secret", out)
    return out.getvalue()


ODF_ENCRYPTED = archive(
    {
        "mimetype": b"application/vnd.oasis.opendocument.text",
        "META-INF/manifest.xml": (
            b"<manifest:manifest "
            b'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">'
            b'<manifest:file-entry manifest:full-path="content.xml">'
            b'<manifest:encryption-data manifest:checksum-type="SHA1"/>'
            b"</manifest:file-entry></manifest:manifest>"
        ),
    }
)


@pytest.mark.parametrize(
    ("data", "status", "reason"),
    [
        (b"x" * (LIMITS.max_bytes + 1), Status.FAILED, "larger than 10 MB"),
        (
            archive({"zeros.bin": b"\0" * 20 * 2**20}),
            Status.FAILED,
            "compressed more than 100:1 (zip bomb)",
        ),
        (
            archive({f"{i}.txt": b"" for i in range(1001)}),
            Status.FAILED,
            "more than 1000 entries (zip bomb)",
        ),
        (archive({"secret.txt": b"hello"}, encrypted=True), Status.PASSWORD_PROTECTED, None),
        (pdf("secret"), Status.PASSWORD_PROTECTED, None),
        (encrypted_ooxml(), Status.PASSWORD_PROTECTED, None),
        (ODF_ENCRYPTED, Status.PASSWORD_PROTECTED, None),
    ],
    ids=[
        "too-big",
        "zip-bomb",
        "too-many-entries",
        "encrypted-zip",
        "encrypted-pdf",
        "encrypted-docx",
        "encrypted-odt",
    ],
)
def test_rejects_files_it_must_not_parse(data: bytes, status: Status, reason: str | None) -> None:
    found = inspect_file(io.BytesIO(data), len(data), "file", None, LIMITS).rejection
    assert found is not None
    assert found.status == status
    assert found.reason == (reason or "password-protected")


def test_opens_pdfs_locked_only_against_printing() -> None:
    assert check(pdf(""), "file.pdf") == ("application/pdf", None)
