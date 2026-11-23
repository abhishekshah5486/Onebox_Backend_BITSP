import base64
import io

import pytest
from PIL import Image

from onebox_rag.ingest.inspect import detect_type
from onebox_rag.models.blocks import BlockType
from onebox_rag.parsers.base import UnreadableFileError
from onebox_rag.parsers.html import parse_html
from onebox_rag.parsers.ocr import rapid  # noqa: F401 - registers the HEIC opener
from onebox_rag.parsers.svg import svg_to_png, without_css_vars

SVG_NS = 'xmlns="http://www.w3.org/2000/svg"'


def png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 40), "red").save(out, "PNG")
    return out.getvalue()


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
