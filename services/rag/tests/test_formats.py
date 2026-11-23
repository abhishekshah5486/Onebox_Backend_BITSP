import base64
import io
import zipfile

import pytest
from PIL import Image

from onebox_rag.ingest.inspect import detect_type
from onebox_rag.models.blocks import BlockType
from onebox_rag.parsers.base import ProtectedFileError, UnreadableFileError
from onebox_rag.parsers.epub import parse_epub
from onebox_rag.parsers.html import parse_html
from onebox_rag.parsers.ocr import rapid  # noqa: F401 - registers the HEIC opener
from onebox_rag.parsers.svg import svg_to_png, without_css_vars

SVG_NS = 'xmlns="http://www.w3.org/2000/svg"'


def png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 40), "red").save(out, "PNG")
    return out.getvalue()


def epub(chapters: dict[str, str], *, encrypted: str | None = None) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as book:
        book.writestr("mimetype", "application/epub+zip")
        book.writestr(
            "META-INF/container.xml",
            '<container><rootfiles><rootfile full-path="OEBPS/book.opf" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        items = "".join(
            f'<item id="{name}" href="{name}.xhtml" media-type="application/xhtml+xml"/>'
            for name in chapters
        )
        book.writestr(
            "OEBPS/book.opf",
            '<package version="3.0"><metadata><title>Rates</title></metadata><manifest>'
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            f'{items}<item id="pic" href="img/p.png" media-type="image/png"/></manifest>'
            # Reading order differs from the manifest's.
            f"<spine>{''.join(f'<itemref idref="{n}"/>' for n in reversed(chapters))}"
            '<itemref idref="nav"/></spine></package>',
        )
        book.writestr("OEBPS/nav.xhtml", "<html><body><p>Contents</p></body></html>")
        for name, body in chapters.items():
            book.writestr(f"OEBPS/{name}.xhtml", f"<html><body>{body}</body></html>")
        book.writestr("OEBPS/img/p.png", png())
        if encrypted:
            book.writestr(
                "META-INF/encryption.xml",
                "<encryption><EncryptedData><EncryptionMethod Algorithm='aes'/><CipherData>"
                f"<CipherReference URI='{encrypted}'/></CipherData></EncryptedData></encryption>",
            )
    return out.getvalue()


def test_reads_an_epub_in_reading_order_with_its_pictures() -> None:
    cover = f'<svg {SVG_NS} aria-label="Cover"><image href="img/p.png"/></svg>'
    data = epub({"two": "<p>Island rates rise in May.</p>", "one": f"{cover}<h1>Shipping</h1>"})
    blocks = parse_epub(data).container.blocks
    texts = [b.data for b in blocks if b.type == BlockType.TEXT]
    assert texts == ["Shipping", "Island rates rise in May."]  # the nav page is left out
    picture = next(b for b in blocks if b.type == BlockType.IMAGE)
    assert str(picture.data).startswith("data:image/png;base64,")


def test_refuses_drm_books_and_non_books() -> None:
    with pytest.raises(ProtectedFileError):
        parse_epub(epub({"one": "<p>x</p>"}, encrypted="OEBPS/one.xhtml"))
    with pytest.raises(UnreadableFileError):
        parse_epub(b"not a zip")


def test_draws_svg_safely() -> None:
    assert svg_to_png(f'<svg {SVG_NS} width="9" height="9"/>'.encode()).startswith(b"\x89PNG")
    assert without_css_vars("fill:var(--a, #B4B4B4);x:var(--b)") == "fill:#B4B4B4;x:var(--b)"
    refused = [
        b'<!DOCTYPE s [<!ENTITY a "b">]><svg>&a;</svg>',
        f'<svg {SVG_NS}><g id="a"><use href="#a"/></g></svg>'.encode(),
        f'<svg {SVG_NS} width="90000" height="90000"/>'.encode(),
    ]
    for svg in refused:
        with pytest.raises(UnreadableFileError):
            svg_to_png(svg)


def test_keeps_inline_html_pictures() -> None:
    svg = base64.b64encode(f'<svg {SVG_NS} width="9" height="9"/>'.encode()).decode()
    raster = "data:image/png;base64," + base64.b64encode(png()).decode()
    html = f'<img src="{raster}"><img src="data:image/svg+xml;base64,{svg}"><img src="https://x/a.png">'
    images = parse_html(html.encode()).container.blocks
    assert [str(b.data)[:22] for b in images[:2]] == ["data:image/png;base64,"] * 2
    assert images[2].data is None and images[2].links == ["https://x/a.png"]


def test_tells_heic_from_mp4_by_name_or_sender() -> None:
    out = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(out, "HEIF")
    photo = out.getvalue()
    assert detect_type(io.BytesIO(photo), "IMG_0001.HEIC", None) == "image/heif"
    assert detect_type(io.BytesIO(photo), "attachment", "image/heic") == "image/heif"
