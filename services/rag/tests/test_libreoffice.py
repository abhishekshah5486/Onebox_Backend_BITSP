import shutil
import zipfile
from io import BytesIO

import pytest

from onebox_rag.parsers.base import UnreadableFileError
from onebox_rag.parsers.libreoffice import convert_with_libreoffice

SOFFICE = shutil.which("soffice")
pytestmark = pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
RTF = rb"{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\f0\pard Refunds take thirty days.\par}"


def test_converts_legacy_formats_to_ooxml() -> None:
    assert SOFFICE is not None
    docx = convert_with_libreoffice(RTF, "rtf", "docx", soffice=SOFFICE, timeout_s=120)
    with zipfile.ZipFile(BytesIO(docx)) as archive:
        assert b"Refunds take thirty days." in archive.read("word/document.xml")


def test_a_file_it_cannot_read_is_unreadable() -> None:
    assert SOFFICE is not None
    with pytest.raises(UnreadableFileError, match=r"\.ppt"):
        convert_with_libreoffice(b"\x00not a deck", "ppt", "pptx", soffice=SOFFICE, timeout_s=120)
