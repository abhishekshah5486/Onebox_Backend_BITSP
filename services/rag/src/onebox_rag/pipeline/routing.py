"""Which engine parses a content (PipesHub's per-revision engine decision)."""

from dataclasses import dataclass
from enum import StrEnum

from onebox_rag.parsers.pdf.inspection import PdfFacts
from onebox_rag.parsers.registry import Parser, parser_for

PDF = "application/pdf"


class PdfEngine(StrEnum):
    # Layout, reading order and tables for digital PDFs (milestone 5).
    DOCLING = "docling"
    # pdfplumber + OpenCV, for PDFs past Docling's limits or while it is down (milestone 6).
    PDFPLUMBER = "pdfplumber"
    # Scanned pages through the OCR provider, a free local model by default (milestone 7).
    OCR = "ocr"


@dataclass(frozen=True)
class PdfLimits:
    docling_max_pages: int
    docling_max_bytes: int


@dataclass(frozen=True)
class Route:
    engine: str
    reason: str


def route_pdf(facts: PdfFacts | None, size: int, limits: PdfLimits) -> Route:
    """Scanned goes to OCR; too many pages or bytes for Docling goes to pdfplumber; else Docling.
    Without facts (inspection failed), size alone decides."""
    if facts is not None and facts.scanned:
        return Route(PdfEngine.OCR, "scanned")
    if size > limits.docling_max_bytes:
        return Route(PdfEngine.PDFPLUMBER, "over_docling_bytes")
    if facts is not None and facts.pages > limits.docling_max_pages:
        return Route(PdfEngine.PDFPLUMBER, "over_docling_pages")
    return Route(PdfEngine.DOCLING, "digital" if facts is not None else "uninspected")


# Engines each later milestone registers; until then a content routed to one waits as unsupported.
PDF_ENGINES: dict[str, Parser] = {}


def parser_for_engine(mime_type: str, engine: str) -> Parser | None:
    if mime_type == PDF:
        return PDF_ENGINES.get(engine)
    found = parser_for(mime_type)
    return found if found is not None and found.engine == engine else None
