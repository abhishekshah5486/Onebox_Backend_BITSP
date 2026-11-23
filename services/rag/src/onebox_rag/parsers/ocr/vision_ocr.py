"""Vision OCR: each page rendered and read by a vision model into Markdown, then parsed like any
Markdown file. Pictures come back as {{IMAGE: description}}."""

import base64
import re
from dataclasses import dataclass

import cv2
import numpy as np
import pypdfium2 as pdfium

from onebox_rag.models.blocks import BlocksContainer, BlockType, DataFormat, ImageMetadata
from onebox_rag.parsers.base import UnreadableFileError
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.markdown import markdown_to_blocks
from onebox_rag.parsers.ocr.rapid import OcrLimits, _frames

IMAGE_PLACEHOLDER = re.compile(r"^\{\{\s*IMAGE\s*:\s*(.*?)\s*\}\}$", re.DOTALL | re.IGNORECASE)
# "3 * 4" would read as emphasis in Markdown.
MULTIPLY = re.compile(r"(?<![0-9A-Za-z])(\d[\dA-Za-z]*)\s*\*\s*(?=\d)")
FENCE = re.compile(r"^```(?:markdown|md)?\s*\n(.*?)\n?```$", re.DOTALL)


@dataclass(frozen=True)
class RenderedPage:
    number: int
    uri: str


def _png_uri(image: np.ndarray) -> str:
    ok, png = cv2.imencode(".png", cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    if not ok:
        raise UnreadableFileError("could not encode a page image")
    return "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()


def render_pages(data: bytes, mime_type: str, limits: OcrLimits) -> list[RenderedPage]:
    """Runs in a parse worker: each PDF page (or image frame) as a PNG data URI."""
    if mime_type != "application/pdf":
        frames = list(_frames(data))
        if len(frames) > limits.max_pages:
            raise UnreadableFileError(f"more than {limits.max_pages} frames to OCR")
        return [RenderedPage(i + 1, _png_uri(frame)) for i, frame in enumerate(frames)]
    try:
        document = pdfium.PdfDocument(data)
    except Exception as err:
        raise UnreadableFileError(f"could not open the PDF ({type(err).__name__})") from err
    try:
        if len(document) > limits.max_pages:
            raise UnreadableFileError(f"more than {limits.max_pages} pages to OCR")
        pages = []
        for index in range(len(document)):
            page = document[index]
            try:
                bitmap = page.render(scale=limits.dpi / 72)
                image = np.ascontiguousarray(bitmap.to_numpy()[:, :, :3])
            finally:
                page.close()
            pages.append(RenderedPage(index + 1, _png_uri(image)))
        return pages
    finally:
        document.close()


def clean_markdown(text: str) -> str:
    text = text.strip()
    fenced = FENCE.match(text)
    if fenced:
        text = fenced.group(1).strip()
    return MULTIPLY.sub("\\1\u00d7", text)


def pages_to_blocks(pages: list[tuple[int, str]]) -> BlocksContainer:
    """Each page's Markdown parsed, cited to its page; placeholders become image blocks."""
    out = BlocksBuilder()
    for number, markdown in pages:
        container = markdown_to_blocks(clean_markdown(markdown))
        for block in container.blocks:
            if block.citation_metadata is not None:
                block.citation_metadata.page_number = number
                block.citation_metadata.line_number = None
            placeholder = IMAGE_PLACEHOLDER.match(block.text().strip())
            if placeholder and block.type == BlockType.TEXT:
                block.type, block.sub_type, block.data = BlockType.IMAGE, None, None
                block.format = DataFormat.TXT
                block.image_metadata = ImageMetadata(description=placeholder.group(1))
        for group in container.block_groups:
            if group.citation_metadata is not None:
                group.citation_metadata.page_number = number
                group.citation_metadata.line_number = None
        out.extend(container)
    return out.build()
