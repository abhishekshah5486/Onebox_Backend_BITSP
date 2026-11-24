import io

import pytest
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from onebox_rag.parsers.pdf.inspection import PdfFacts, inspect_pdf, sample_indices
from onebox_rag.pipeline.routing import PdfLimits, route_pdf

LOREM = "The refund window is thirty days from delivery for every order placed online. " * 2


def make_pdf(pages: list[str]) -> bytes:
    """One page per entry: "text" is a full digital page, "drawing" has no text layer at all,
    and "speck" has a single tiny word (a text layer, but a picture of a page)."""
    out = io.BytesIO()
    pdf = canvas.Canvas(out, pagesize=A4)
    for kind in pages:
        if kind == "text":
            for line in range(40):
                pdf.drawString(40, 800 - line * 18, LOREM[:95])
        elif kind == "drawing":
            pdf.rect(50, 50, 400, 600, fill=1)
        else:
            pdf.setFont("Helvetica", 4)
            pdf.drawString(40, 40, "x")
        pdf.showPage()
    pdf.save()
    return out.getvalue()


@pytest.mark.parametrize(
    ("pages", "scanned", "textless"),
    [
        (["text", "text", "text"], False, 0),
        (["drawing", "drawing", "text"], True, 2),
        (["drawing", "text", "text"], False, 1),
        # Text layers exist, but each page is a picture: pdfplumber's check flags them.
        (["speck", "speck", "text"], True, 0),
    ],
    ids=["digital", "mostly-no-text-layer", "mostly-digital", "text-layer-but-pictures"],
)
def test_tells_scanned_pdfs_from_digital_ones(
    pages: list[str], scanned: bool, textless: int
) -> None:
    facts = inspect_pdf(make_pdf(pages), sample_pages=30, ocr_share=0.5)
    assert (facts.pages, facts.scanned, facts.textless_pages) == (len(pages), scanned, textless)


def test_samples_long_documents_the_same_way_every_time() -> None:
    picked = sample_indices(1000, 30)
    assert len(picked) == 30 and picked[0] == 0 and picked[-1] == 999
    assert picked == sample_indices(1000, 30)
    assert sample_indices(10, 30) == list(range(10))


LIMITS = PdfLimits(docling_max_pages=30, docling_max_bytes=100 * 2**20)


@pytest.mark.parametrize(
    ("facts", "size", "engine", "reason"),
    [
        (PdfFacts(5, 5, 1.0, scanned=True), 1_000, "ocr", "scanned"),
        (PdfFacts(500, 0, 0.0, scanned=False), 1_000, "pdfplumber", "over_docling_pages"),
        (PdfFacts(5, 0, 0.0, scanned=False), 200 * 2**20, "pdfplumber", "over_docling_bytes"),
        (PdfFacts(5, 0, 0.0, scanned=False), 1_000, "docling", "digital"),
        (None, 1_000, "docling", "uninspected"),
    ],
)
def test_routes_each_pdf_to_one_engine(
    facts: PdfFacts | None, size: int, engine: str, reason: str
) -> None:
    route = route_pdf(facts, size, LIMITS)
    assert (route.engine, route.reason) == (engine, reason)
