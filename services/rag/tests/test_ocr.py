import io

from PIL import Image, ImageDraw, ImageFont

from onebox_rag.models.blocks import BlockSubType, BlockType, GroupType
from onebox_rag.parsers.ocr.rapid import OcrLimits, parse_image, parse_scanned_pdf
from tests.pdf_samples import handbook, scanned

LIMITS = OcrLimits(dpi=200, max_pages=500)


def test_reads_a_scan_like_the_digital_original() -> None:
    container = parse_scanned_pdf(scanned(handbook()), "application/pdf", LIMITS).container
    assert container.problems() == []
    headings = [b.text() for b in container.blocks if b.sub_type == BlockSubType.HEADING]
    assert headings[:3] == ["Returns and refunds", "Eligibility", "Plans"]
    row = next(b for b in container.blocks if b.text().startswith("Plan: Pro"))
    assert row.citation_metadata is not None
    assert row.citation_metadata.heading_path == ["Returns and refunds", "Plans"]
    assert row.citation_metadata.page_number == 2
    # The bullets (a dot glued to the word on the scan) and the numbers both make lists.
    lists = [g.type for g in container.block_groups if g.type != GroupType.TABLE]
    assert lists == [GroupType.LIST, GroupType.ORDERED_LIST]
    rows = [b.text() for b in container.blocks if b.type == BlockType.TABLE_ROW]
    assert "Region: Islands, Carrier: Parcelforce, Cost: 9.90" in rows
    left = [b.text()[:8] for b in container.blocks if b.text().startswith(("Left 4", "Right 4"))]
    assert left == [*(f"Left 4.{k}" for k in range(4)), *(f"Right 4.{k}"[:8] for k in range(4))]


def picture(text: str) -> Image.Image:
    image = Image.new("RGB", (900, 200), "white")
    ImageDraw.Draw(image).text((30, 60), text, fill="black", font=ImageFont.load_default(size=48))
    return image


def test_reads_image_files_frame_by_frame() -> None:
    out = io.BytesIO()
    first, second = picture("Invoice 2231 paid"), picture("Delivery on Monday")
    first.save(out, "TIFF", save_all=True, append_images=[second])
    container = parse_image(out.getvalue(), "image/tiff", LIMITS).container
    images = [b for b in container.blocks if b.type == BlockType.IMAGE]
    assert [str(b.data)[:22] for b in images] == ["data:image/png;base64,"] * 2
    texts = {
        (b.citation_metadata.page_number, b.text())
        for b in container.blocks
        if b.type == BlockType.TEXT and b.citation_metadata is not None
    }
    assert texts == {(1, "Invoice 2231 paid"), (2, "Delivery on Monday")}
