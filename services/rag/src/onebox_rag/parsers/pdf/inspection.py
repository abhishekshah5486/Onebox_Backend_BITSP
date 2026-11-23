"""Whether a PDF needs OCR, and how many pages it has (PipesHub's inspection rules).

Runs in a parse worker. pdfium counts each page's text-layer characters cheaply: when at least
half the pages have none, the PDF is scanned. Otherwise a fixed sample of the pages with text
goes through pdfplumber's layout check, since text can be present yet useless (a scan with a
bad hidden layer, glyphs with no Unicode mapping, a page that is one big image).
"""

import io
import random
from dataclasses import dataclass
from typing import Any

import pdfplumber
import pypdfium2

# A page whose text covers less than this share of its area is a picture of text.
LOW_DENSITY = 0.01
MIN_TEXT_CHARS = 100
MIN_IMAGE_SIDE = 100
MIN_SIGNIFICANT_IMAGES = 2
DOMINANT_IMAGE_SHARE = 0.5
MAX_TEXT_WITH_DOMINANT_IMAGE = 250
UNMAPPED_GLYPH_SHARE = 0.3
MIN_UNMAPPED_GLYPHS = 20


@dataclass(frozen=True)
class PdfFacts:
    pages: int
    # Pages with no text layer at all.
    textless_pages: int
    # Estimated share of pages that need OCR (exact when every text page was checked).
    ocr_share: float
    scanned: bool


def sample_indices(count: int, limit: int) -> list[int]:
    """Every index up to `limit`; past it, the first, the last and one drawn from each of
    `limit` - 2 equal runs between, seeded by the count so a document always gets one sample.
    A drawn offset can't line up with a repeating layout the way a fixed stride can."""
    limit = max(1, limit)
    if count <= limit:
        return list(range(count))
    if limit == 1:
        return [0]
    draw = random.Random(count)  # noqa: S311 - sampling, not security
    runs, middle = limit - 2, count - 2
    chosen = [0]
    for run in range(runs):
        chosen.append(draw.randrange(1 + run * middle // runs, 1 + (run + 1) * middle // runs))
    chosen.append(count - 1)
    return chosen


def text_layer_counts(content: bytes) -> list[int]:
    document = pypdfium2.PdfDocument(content)
    try:
        counts = []
        for page in document:
            textpage = page.get_textpage()
            try:
                counts.append(textpage.count_chars())
            finally:
                textpage.close()
                page.close()
        return counts
    finally:
        document.close()


def page_needs_ocr(page: Any) -> bool:
    try:
        text = (page.extract_text() or "").strip()
        words = page.extract_words()
        images = page.images
        area = page.width * page.height
        big = [
            img
            for img in images
            if (img.get("width") or 0) > MIN_IMAGE_SIDE
            and (img.get("height") or 0) > MIN_IMAGE_SIDE
        ]
        density = (
            sum((w["x1"] - w["x0"]) * (w["bottom"] - w["top"]) for w in words) / area
            if words and area > 0
            else 0
        )
        dominant = (
            area > 0
            and len(text) < MAX_TEXT_WITH_DOMINANT_IMAGE
            and any(
                (img.get("width") or 0) * (img.get("height") or 0) / area >= DOMINANT_IMAGE_SHARE
                for img in images
            )
        )
        glyphs = [c["text"] for c in page.chars if c["text"].strip()]
        unmapped = sum(1 for g in glyphs if g.startswith("(cid:"))
        unreadable = unmapped >= MIN_UNMAPPED_GLYPHS and unmapped >= UNMAPPED_GLYPH_SHARE * len(
            glyphs
        )
        return (
            (len(text) < MIN_TEXT_CHARS and len(big) > MIN_SIGNIFICANT_IMAGES)
            or density < LOW_DENSITY
            or dominant
            or unreadable
        )
    except Exception:
        # A page pdfplumber can't analyse is read by OCR, which only needs its pixels.
        return True


def inspect_pdf(content: bytes, sample_pages: int, ocr_share: float) -> PdfFacts:
    counts = text_layer_counts(content)
    total = len(counts)
    if total == 0:
        return PdfFacts(0, 0, 0.0, scanned=False)
    textless = sum(1 for chars in counts if chars == 0)
    if textless / total >= ocr_share:
        return PdfFacts(total, textless, textless / total, scanned=True)
    with_text = [i for i, chars in enumerate(counts) if chars > 0]
    sampled = [with_text[i] for i in sample_indices(len(with_text), sample_pages)]
    flagged = 0
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for index in sampled:
            page = pdf.pages[index]
            try:
                flagged += page_needs_ocr(page)
            finally:
                page.close()
    # The sample stands for every page with text.
    estimated = flagged * len(with_text) / len(sampled) if sampled else 0
    share = (textless + estimated) / total
    return PdfFacts(total, textless, round(share, 3), scanned=share >= ocr_share - 1e-9)


__all__ = ["PdfFacts", "inspect_pdf", "sample_indices"]
