"""The pdfplumber + OpenCV engine: PDFs past Docling's limits or while it is down."""

import base64
import io
import re
from collections import Counter
from typing import Any

import pdfplumber
import pypdfium2 as pdfium

from onebox_rag.models.blocks import (
    BlockGroup,
    BlockSubType,
    BlockType,
    DataFormat,
    GroupType,
    ImageMetadata,
    ListMetadata,
    Point,
)
from onebox_rag.parsers.base import ParseResult, UnreadableFileError
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.pdf.layout import Kind, Region, page_regions
from onebox_rag.parsers.tables import add_table, looks_like_header

# A heading is one short line set apart by weight or size.
HEADING_MAX_CHARS = 160
HEADING_SIZE_RATIO = 1.15
MAX_HEADING_LEVELS = 6
# Running headers, footers and page numbers: short lines in the top or bottom 8% repeated on at
# least 3 pages and a fifth of them; the first copy stays, as it may be said nowhere else.
MARGIN_BAND = 0.08
RUNNING_MAX_CHARS = 80
RUNNING_REPEATS = 3
RUNNING_PAGE_SHARE = 0.2
PAGE_NUMBER = re.compile(
    r"^(?:page\s+)?[-\u2013\u2014]?\s*\d{1,4}\s*[-\u2013\u2014]?(?:\s+of\s+\d{1,4})?$",
    re.IGNORECASE,
)
# A lone number off the margins is a page number only when this many pages share its offset.
PAGE_SEQUENCE_PAGES = 3


class Page:
    def __init__(self, number: int, width: float, height: float, regions: list[Region]) -> None:
        self.number, self.width, self.height, self.regions = number, width, height, regions


def _offset(text: str, page: int) -> int:
    match = re.search(r"\d+", text)
    return int(match.group()) - page if match else 0


def running_noise(pages: list[Page]) -> set[int]:
    """id() of every page number and every repeated margin line past its first copy."""
    candidates = []
    for page in pages:
        texts = [r for r in page.regions if r.kind == Kind.TEXT]
        for region in texts:
            text = region.text.strip()
            if len(text) > RUNNING_MAX_CHARS:
                continue
            in_margin = region.box[1] <= page.height * MARGIN_BAND or region.box[
                3
            ] >= page.height * (1 - MARGIN_BAND)
            at_edge = (region is texts[0] or region is texts[-1]) and PAGE_NUMBER.match(text)
            if in_margin or at_edge:
                norm = re.sub(r"\d+", "#", " ".join(text.lower().split()))
                candidates.append((region, text, norm, in_margin, page.number))
    repeats = Counter(norm for _, _, norm, margin, _ in candidates if margin)
    needed = max(RUNNING_REPEATS, len(pages) * RUNNING_PAGE_SHARE)
    offsets = Counter(_offset(t, n) for _, t, _, _, n in candidates if PAGE_NUMBER.match(t))
    first: dict[str, Region] = {}
    for region, _, norm, margin, _ in candidates:
        if margin:
            first.setdefault(norm, region)
    return {
        id(region)
        for region, text, norm, margin, number in candidates
        if (margin and repeats[norm] >= needed and first[norm] is not region)
        or (
            PAGE_NUMBER.match(text)
            and (margin or offsets[_offset(text, number)] >= PAGE_SEQUENCE_PAGES)
        )
    }


def heading_levels(pages: list[Page], ratio: float, tolerance: float) -> tuple[float, list[float]]:
    """The body size (the median text size) and the size of each heading level, largest first.
    Sizes within `tolerance` of a level share it (OCR measures sizes only roughly)."""
    sizes = sorted(r.size for p in pages for r in p.regions if r.kind == Kind.TEXT and r.size)
    body = sizes[len(sizes) // 2] if sizes else 0.0
    larger = sorted(
        {
            round(r.size * 2) / 2
            for p in pages
            for r in p.regions
            if _is_heading(r, body, ratio) and r.size >= body * ratio
        },
        reverse=True,
    )
    levels: list[float] = []
    for size in larger:
        if not levels or size < levels[-1] / (1 + tolerance):
            levels.append(size)
    return body, levels


def _level(size: float, levels: list[float], tolerance: float) -> int:
    """The first level this size reaches; smaller (bold at body size) headings come after all."""
    size = round(size * 2) / 2
    for i, level in enumerate(levels):
        if size >= level / (1 + tolerance):
            return min(i + 1, MAX_HEADING_LEVELS)
    return min(len(levels) + 1, MAX_HEADING_LEVELS)


def _is_heading(region: Region, body: float, ratio: float) -> bool:
    text = region.text.strip()
    if region.kind != Kind.TEXT or region.lines != 1 or not text or len(text) > HEADING_MAX_CHARS:
        return False
    return region.bold or (body > 0 and region.size >= body * ratio)


def _citation(page: Page, region: Region) -> dict[str, Any]:
    x0, top, x1, bottom = region.box
    x0, x1 = x0 / page.width, x1 / page.width
    top, bottom = top / page.height, bottom / page.height
    return {
        "page_number": page.number,
        "bounding_boxes": [
            Point(x=x0, y=top),
            Point(x=x1, y=top),
            Point(x=x1, y=bottom),
            Point(x=x0, y=bottom),
        ],
    }


def build_blocks(
    pages: list[Page], heading_ratio: float = HEADING_SIZE_RATIO, size_tolerance: float = 0.0
) -> BlocksBuilder:
    out = BlocksBuilder()
    noise = running_noise(pages)
    body, levels = heading_levels(pages, heading_ratio, size_tolerance)
    for page in pages:
        open_list: BlockGroup | None = None
        for region in page.regions:
            if id(region) in noise:
                continue
            cite = _citation(page, region)
            if region.kind != Kind.LIST_ITEM:
                open_list = None
            if region.kind == Kind.TABLE and region.grid:
                header = region.grid[0] if looks_like_header(region.grid[0]) else []
                rows = region.grid[1:] if header else region.grid
                add_table(out, header, rows, **cite)
            elif region.kind == Kind.IMAGE:
                if region.image is None and not region.captions:
                    continue
                uri = (
                    "data:image/png;base64," + base64.b64encode(region.image).decode()
                    if region.image
                    else None
                )
                out.block(
                    BlockType.IMAGE,
                    uri,
                    format=DataFormat.BASE64,
                    image_metadata=ImageMetadata(
                        captions=region.captions, image_format="image/png"
                    ),
                    citation_metadata=out.citation(**cite),
                )
            elif region.kind == Kind.LIST_ITEM:
                ordered_type = GroupType.ORDERED_LIST if region.ordered else GroupType.LIST
                if open_list is None or open_list.type != ordered_type:
                    style = "numbered" if region.ordered else "bullet"
                    open_list = out.group(
                        GroupType.ORDERED_LIST if region.ordered else GroupType.LIST,
                        list_metadata=ListMetadata(list_style=style),
                    )
                out.text(
                    region.text,
                    parent=open_list,
                    sub_type=BlockSubType.LIST_ITEM,
                    citation_metadata=out.citation(**cite),
                )
            elif _is_heading(region, body, heading_ratio):
                level = _level(region.size, levels, size_tolerance)
                out.heading(level, region.text)
                out.text(
                    region.text,
                    sub_type=BlockSubType.HEADING,
                    citation_metadata=out.citation(**cite),
                )
            else:
                out.text(region.text, citation_metadata=out.citation(**cite))
    return out


def parse_pdf_layout(data: bytes, mime_type: str = "") -> ParseResult:
    pages: list[Page] = []
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            raster_doc = pdfium.PdfDocument(data)
            try:
                for index, page in enumerate(pdf.pages):
                    pdfium_page = raster_doc[index]
                    try:
                        regions = page_regions(page, pdfium_page)
                    finally:
                        pdfium_page.close()
                    pages.append(Page(index + 1, float(page.width), float(page.height), regions))
                    # Each page caches its characters and layout until closed (~5 MB a page).
                    page.close()
            finally:
                raster_doc.close()
    except UnreadableFileError:
        raise
    except Exception as err:
        raise UnreadableFileError(f"pdfplumber could not read it ({type(err).__name__})") from err
    return ParseResult(build_blocks(pages).build())
