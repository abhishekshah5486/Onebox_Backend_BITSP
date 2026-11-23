import io
import json
from typing import Any

import httpx
import pytest
from PIL import Image, ImageDraw, ImageFont

from onebox_rag.models.blocks import BlockSubType, BlockType, GroupType
from onebox_rag.parsers.ocr.rapid import OcrLimits, parse_image, parse_scanned_pdf
from onebox_rag.parsers.ocr.vision_ocr import pages_to_blocks
from onebox_rag.pipeline import vision
from onebox_rag.pipeline.vision import (
    VisionClient,
    VisionSettings,
    VisionTruncatedError,
    VisionUnavailableError,
)
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


def test_turns_vision_markdown_into_cited_blocks() -> None:
    page = (
        "```markdown\n# Refunds\n\n{{IMAGE: Bar chart of returns by quarter}}\n\n"
        "| Plan | Price |\n|---|---|\n| Pro | 2 * 5 |\n```"
    )
    container = pages_to_blocks([(3, page)])
    assert container.problems() == []
    image = next(b for b in container.blocks if b.type == BlockType.IMAGE)
    assert image.image_metadata is not None
    assert image.image_metadata.description == "Bar chart of returns by quarter"
    row = next(b for b in container.blocks if b.type == BlockType.TABLE_ROW)
    assert row.text() == "Plan: Pro, Price: 2\u00d75"
    assert {b.citation_metadata.page_number for b in container.blocks if b.citation_metadata} == {3}


def client(handler: Any, model: str = "llava") -> VisionClient:
    settings = VisionSettings("http://vision/v1", model, "key", 5, 4096, 2, retries=2)
    return VisionClient(settings, httpx.MockTransport(handler))


async def test_vision_client_retries_and_rejects_cut_off_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(vision, "RETRY_BASE_S", 0)
    calls: list[dict[str, Any]] = []

    def flaky(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            return httpx.Response(503, text="loading model")
        finish = "length" if "cut" in request.content.decode() else "stop"
        message = {"content": "# Page"}
        return httpx.Response(
            200, json={"choices": [{"message": message, "finish_reason": finish}]}
        )

    reader = client(flaky, model="qwen2.5-vl")
    assert await reader.read("read this", "data:image/png;base64,AA") == "# Page"
    assert calls[-1]["temperature"] == 0 and calls[-1]["max_tokens"] == 4096
    # Qwen models get their thinking switched off.
    assert calls[-1]["chat_template_kwargs"] == {"enable_thinking": False}
    with pytest.raises(VisionTruncatedError):
        await reader.read("cut", "data:image/png;base64,AA")

    def refused(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad key")

    with pytest.raises(VisionUnavailableError, match="401"):
        await client(refused).read("read this", "data:image/png;base64,AA")
