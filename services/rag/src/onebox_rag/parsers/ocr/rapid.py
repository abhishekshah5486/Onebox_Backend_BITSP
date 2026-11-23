"""OCR with RapidOCR (PP-OCR models on ONNX Runtime, CPU): the free local default. Its words
go through the same layout steps as a digital PDF's, so scans get columns, headings, lists
and tables too."""

import io
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageSequence, UnidentifiedImageError

from onebox_rag.parsers.base import ParseResult, UnreadableFileError
from onebox_rag.parsers.pdf.layout import Kind, PageRaster, Region, Word, ocr_regions
from onebox_rag.parsers.pdf.pdfplumber_engine import Page, build_blocks

# Words read with less confidence are noise more often than text.
MIN_WORD_SCORE = 0.5
# Font size from the ink: the detector's boxes are padded by a roughly constant number of pixels
# and descenders come and go, so a line's size is its tallest word's height above the baseline
# (cap or ascender height, about 0.72 of the size). Still rougher than a PDF's, so blocks split
# on a 15% change and heading sizes within 15% share a level.
SIZE_PER_HEIGHT = 1 / 0.72
BASELINE_ROW_SHARE = 0.3
OCR_SIZE_CHANGE = 0.15
OCR_HEADING_RATIO = 1.15
# Weight from the ink: a line whose strokes are this much thicker than the page's usual text is
# bold (or set larger; either way it is emphasis, and starts a block of its own).
BOLD_STROKE_RATIO = 1.3
# Decoded images past this are refused (decompression bombs); bigger ones are scaled down.
MAX_IMAGE_PIXELS = 64 * 2**20
MAX_IMAGE_EDGE_PX = 4096
# Image files are read as if printed at this resolution, for sizes in points.
IMAGE_DPI = 150
STORED_IMAGE_EDGE_PX = 1600


@dataclass(frozen=True)
class OcrLimits:
    dpi: int
    max_pages: int


@lru_cache(maxsize=1)
def _engine() -> Any:
    from rapidocr import RapidOCR

    return RapidOCR(params={"Global.log_level": "error", "Global.return_word_box": True})


def ink_metrics(gray: np.ndarray, box: list[list[float]]) -> tuple[float, float]:
    """The ink in a word's box: its height above the baseline in pixels (descenders left out; the
    baseline is the last row still dense with ink) and its mean stroke thickness (twice the
    mean distance from ink to paper)."""
    xs, ys = [int(p[0]) for p in box], [int(p[1]) for p in box]
    crop = gray[max(0, min(ys)) : max(ys), max(0, min(xs)) : max(xs)]
    if crop.size == 0:
        return 0.0, 0.0
    _, ink = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    per_row = (ink > 0).sum(axis=1)
    rows = np.flatnonzero(per_row)
    dense = np.flatnonzero(per_row >= BASELINE_ROW_SHARE * per_row.max()) if rows.size else rows
    distance = cv2.distanceTransform(ink, cv2.DIST_L2, 3)
    inked = distance[ink > 0]
    height = float(dense[-1] - rows[0] + 1) if rows.size else 0.0
    return height, float(2 * inked.mean()) if inked.size else 0.0


def ocr_words(image: np.ndarray, dpi: float) -> list[Word]:
    """Words with boxes in points, shaped like pdfplumber's; "Bold" in the font name when the
    line's strokes are thick."""
    result = _engine()(image)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    to_points = 72 / dpi
    lines = []
    for line in result.word_results or ():
        metrics = [ink_metrics(gray, box) for _, _, box in line]
        # The tallest word spans ascender to descender; nearly every line has one.
        height = max((h for h, _ in metrics), default=0.0)
        weight = float(np.median([s for _, s in metrics])) if metrics else 0.0
        lines.append((line, height * to_points * SIZE_PER_HEIGHT, weight))
    usual = float(np.median([w for _, _, w in lines if w])) if any(w for _, _, w in lines) else 0
    words: list[Word] = []
    for line, size, weight in lines:
        bold = usual > 0 and weight >= usual * BOLD_STROKE_RATIO
        for text, score, box in line:
            text = str(text).strip()
            if not text or float(score) < MIN_WORD_SCORE:
                continue
            xs, ys = [p[0] * to_points for p in box], [p[1] * to_points for p in box]
            top, bottom = min(ys), max(ys)
            words.append(
                {
                    "text": text,
                    "x0": min(xs),
                    "x1": max(xs),
                    "top": top,
                    "bottom": bottom,
                    "size": size,
                    "fontname": "Bold" if bold else "",
                }
            )
    return words


def _page(number: int, image: np.ndarray, dpi: float) -> Page:
    height_px, width_px = image.shape[:2]
    width, height = width_px * 72 / dpi, height_px * 72 / dpi
    raster = PageRaster(None, width, image=image, dpi=int(dpi))
    regions = ocr_regions(ocr_words(image, dpi), width, height, raster, OCR_SIZE_CHANGE)
    return Page(number, width, height, regions)


def parse_scanned_pdf(data: bytes, mime_type: str, limits: OcrLimits) -> ParseResult:
    try:
        document = pdfium.PdfDocument(data)
    except Exception as err:
        raise UnreadableFileError(f"could not open the PDF ({type(err).__name__})") from err
    try:
        if len(document) > limits.max_pages:
            raise UnreadableFileError(f"more than {limits.max_pages} pages to OCR")
        pages = []
        for index in range(len(document)):
            pdf_page = document[index]
            try:
                bitmap = pdf_page.render(scale=limits.dpi / 72)
                image = np.ascontiguousarray(bitmap.to_numpy()[:, :, :3])
            finally:
                pdf_page.close()
            pages.append(_page(index + 1, image, limits.dpi))
    finally:
        document.close()
    return ParseResult(build_blocks(pages, OCR_HEADING_RATIO, OCR_SIZE_CHANGE).build())


def _frames(data: bytes) -> Iterator[np.ndarray]:
    """Every frame (a TIFF's pages, a GIF's frames) as RGB, scaled to MAX_IMAGE_EDGE_PX."""
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as image:
            for frame in ImageSequence.Iterator(image):
                rgb = frame.convert("RGB")
                rgb.thumbnail((MAX_IMAGE_EDGE_PX, MAX_IMAGE_EDGE_PX))
                yield np.asarray(rgb)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as err:
        raise UnreadableFileError(f"could not read the image ({type(err).__name__})") from err


def stored_png(image: np.ndarray) -> bytes | None:
    """The picture itself as a PNG, for its image block and its description."""
    longest = max(image.shape[:2])
    if longest > STORED_IMAGE_EDGE_PX:
        factor = STORED_IMAGE_EDGE_PX / longest
        image = cv2.resize(image, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    ok, png = cv2.imencode(".png", cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
    return png.tobytes() if ok else None


def parse_image(data: bytes, mime_type: str, limits: OcrLimits) -> ParseResult:
    """An image file: the picture as an image block (for its description), then any text in it,
    each frame as a page."""
    pages = []
    for index, frame in enumerate(_frames(data)):
        if index >= limits.max_pages:
            raise UnreadableFileError(f"more than {limits.max_pages} frames to OCR")
        page = _page(index + 1, frame, IMAGE_DPI)
        picture = Region(Kind.IMAGE, (0.0, 0.0, page.width, page.height), image=stored_png(frame))
        page.regions.insert(0, picture)
        pages.append(page)
    if not pages:
        raise UnreadableFileError("the image has no frames")
    return ParseResult(build_blocks(pages, OCR_HEADING_RATIO, OCR_SIZE_CHANGE).build())
