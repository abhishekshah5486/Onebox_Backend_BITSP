"""The Docling service for real: its models, LibreOffice, and the RAG service calling it."""

import io
import shutil
import socket
import threading
import time
from collections.abc import Iterator

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from onebox_rag.app import create_app
from onebox_rag.config import Settings
from onebox_rag.docling.config import load_docling_settings
from onebox_rag.docling.service import create_docling_app
from onebox_rag.parsers.libreoffice import convert_with_libreoffice
from tests.test_ingest_int import Json, parsed, settled, upload, wait_for
from tests.test_pdf_routing import make_pdf
from tests.tokens import bearer, fake_verifier

pytest.importorskip("docling")
pytestmark = [pytest.mark.integration, pytest.mark.docling]
DOCLING_WAIT_S = 600


@pytest.fixture(scope="module")
def docling_url() -> Iterator[str]:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    settings = load_docling_settings(
        _env_file=None,
        CREDENTIALS_ENCRYPTION_KEY="AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    )
    config = uvicorn.Config(
        create_docling_app(settings), host="127.0.0.1", port=port, log_config=None
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + DOCLING_WAIT_S
    while True:
        try:
            if httpx.get(f"{url}/health/ready").status_code == 200:
                break
        except httpx.TransportError:
            pass
        assert time.monotonic() < deadline, "Docling never loaded its models"
        time.sleep(1)
    yield url
    server.should_exit = True
    thread.join(30)


@pytest.fixture
def client(live_settings: Settings, docling_url: str) -> Iterator[TestClient]:
    settings = live_settings.model_copy(update={"RAG_DOCLING_URL": docling_url})
    with TestClient(create_app(settings, verifier=fake_verifier())) as test_client:
        while test_client.get("/health/ready").status_code != 200:
            time.sleep(0.5)
        yield test_client


def docx_bytes() -> bytes:
    from docx import Document

    doc = Document()
    doc.add_heading("Refund policy", 1)
    doc.add_paragraph("Refunds take thirty days from delivery.")
    table = doc.add_table(rows=2, cols=2)
    for (row, col), value in {
        (0, 0): "Plan",
        (0, 1): "Price",
        (1, 0): "Pro",
        (1, 1): "$10",
    }.items():
        table.cell(row, col).text = value
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def pptx_bytes() -> bytes:
    from pptx import Presentation

    deck = Presentation()
    for title in ("Quarterly review", "Refunds are down"):
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = title
    out = io.BytesIO()
    deck.save(out)
    return out.getvalue()


def blocks(client: TestClient, record: Json) -> list[Json]:
    response = client.get(f"/rag/records/{record['id']}/blocks", headers=bearer("u1"))
    assert response.status_code == 200, response.text
    return list(response.json()["blocks"])


def test_reads_word_powerpoint_pdf_and_legacy_files(client: TestClient) -> None:
    soffice = shutil.which("soffice")
    if soffice is None:
        pytest.skip("LibreOffice is not installed")
    doc = convert_with_libreoffice(docx_bytes(), "docx", "doc", soffice=soffice, timeout_s=120)
    files = [
        ("policy.docx", docx_bytes()),
        ("review.pptx", pptx_bytes()),
        ("terms.pdf", make_pdf(["text", "text"])),
        ("old.doc", doc),
    ]
    records = upload(client, *files, kb="office")
    done = [wait_for(client, r["id"], settled, timeout_s=DOCLING_WAIT_S) for r in records]
    assert all(parsed(r) for r in done), [(r["name"], r["status"], r["reason"]) for r in done]

    docx, pptx, pdf, legacy = (blocks(client, r) for r in done)
    row = next(b for b in docx if b["type"] == "table_row")
    assert row["data"]["text"] == "Plan: Pro, Price: $10"
    assert row["citationMetadata"]["headingPath"] == ["Refund policy"]
    assert {b["citationMetadata"].get("slideNumber") for b in pptx} == {1, 2}
    first = pdf[0]["citationMetadata"]
    assert first["pageNumber"] == 1 and len(first["boundingBoxes"]) == 4
    assert any("thirty days" in str(b["data"]) for b in legacy)


def test_only_the_rag_service_may_call_it(docling_url: str) -> None:
    response = httpx.post(
        f"{docling_url}/convert", files={"file": ("a.pdf", b"%PDF")}, data={"target": "pdf"}
    )
    assert response.status_code == 401
