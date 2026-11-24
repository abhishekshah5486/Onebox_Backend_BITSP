import asyncio
import io
import time
from collections.abc import Callable, Iterator
from email.message import EmailMessage
from typing import Any

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from onebox_rag.app import create_app
from onebox_rag.config import Settings
from onebox_rag.ingest.blobs import BlobStore
from tests.pdf_samples import handbook, scanned
from tests.test_inspect import OOXML, archive, ooxml
from tests.test_ocr import picture
from tests.tokens import bearer, fake_verifier

pytestmark = pytest.mark.integration
Json = dict[str, Any]


@pytest.fixture
def client(live_settings: Settings) -> Iterator[TestClient]:
    app = create_app(live_settings, verifier=fake_verifier())
    with TestClient(app) as test_client:
        # Indexes and the bucket are created in the background at startup.
        deadline = time.monotonic() + 30
        while test_client.get("/health/ready").status_code != 200:
            assert time.monotonic() < deadline, "stores never became ready"
            time.sleep(0.5)
        yield test_client


def upload(client: TestClient, *files: tuple[str, bytes], kb: str, user: str = "u1") -> list[Json]:
    response = client.post(
        "/rag/documents",
        headers=bearer(user),
        files=[("files", (name, data, "application/octet-stream")) for name, data in files],
        data={"knowledgeBase": kb},
    )
    assert response.status_code == 201, response.text
    return list(response.json()["records"])


def wait_for(
    client: TestClient,
    record_id: str,
    done: Callable[[Json], bool],
    user: str = "u1",
    timeout_s: float = 30,
) -> Json:
    deadline = time.monotonic() + timeout_s
    while True:
        record: Json = client.get(f"/rag/records/{record_id}", headers=bearer(user)).json()
        if done(record):
            return record
        assert time.monotonic() < deadline, f"record never settled: {record}"
        time.sleep(0.2)


def parsed(record: Json) -> bool:
    return bool(record["status"] == "queued" and record["stage"] == "index")


def settled(record: Json) -> bool:
    return record["status"] not in {"queued", "in_progress"} or parsed(record)


def email_with_attachments() -> bytes:
    mail = EmailMessage()
    mail["From"], mail["To"], mail["Subject"] = "ops@acme.co", "me@onebox.dev", "Q3 numbers"
    mail.set_content("Numbers attached; the refund policy is 30 days.")
    mail.add_attachment(
        b"region,revenue\nnorth,120\nsouth,95\n", maintype="text", subtype="csv", filename="q3.csv"
    )
    mail.add_attachment(b"%PDF-1.7\n", maintype="application", subtype="pdf", filename="scan.pdf")
    return mail.as_bytes()


def test_parses_an_email_and_its_attachments_once_per_content(client: TestClient) -> None:
    eml = email_with_attachments()
    [mail] = upload(client, ("q3.eml", eml), kb="inbox")
    mail = wait_for(client, mail["id"], parsed)
    response = client.get(f"/rag/records/{mail['id']}/blocks", headers=bearer("u1"))
    assert response.status_code == 200, response.text
    blocks = response.json()
    assert blocks["engine"] == "email"
    assert any("refund policy is 30 days" in str(b.get("data")) for b in blocks["blocks"])

    children = client.get("/rag/records?sourceId=inbox", headers=bearer("u1")).json()["records"]
    by_name = {r["name"]: r for r in children if r["parentId"] == mail["id"]}
    assert set(by_name) == {"q3.csv", "scan.pdf"}
    csv_record = wait_for(client, by_name["q3.csv"]["id"], parsed)
    pdf_record = wait_for(client, by_name["scan.pdf"]["id"], settled)
    # Only a PDF header, nothing more: read (by pdfplumber, with no Docling here) and found broken.
    assert pdf_record["status"] == "failed"
    assert pdf_record["reason"].startswith("pdfplumber could not read it")
    blocks = client.get(f"/rag/records/{csv_record['id']}/blocks", headers=bearer("u1")).json()
    rows = [b for b in blocks["blocks"] if not b["tableRowMetadata"].get("isHeader")]
    assert [b["data"]["text"] for b in rows] == [
        "region: north, revenue: 120",
        "region: south, revenue: 95",
    ]
    assert rows[0]["citationMetadata"]["lineNumber"] == 2

    # The same email in another place shares the parsed content: done at once, children included.
    [copy] = upload(client, ("again.eml", eml), kb="archive")
    assert copy["contentId"] == mail["contentId"]
    assert (copy["status"], copy["stage"]) == ("queued", "index")
    copies = client.get("/rag/records?sourceId=archive", headers=bearer("u1")).json()["records"]
    assert {r["name"] for r in copies if r["parentId"] == copy["id"]} == {"q3.csv", "scan.pdf"}


def test_rejects_unsafe_files_and_dedupes_within_a_source(client: TestClient) -> None:
    doc = ooxml(f"{OOXML}.wordprocessingml.document")
    bomb = archive({"zeros.bin": b"\0" * 20 * 2**20})
    word, rejected = upload(client, ("Leave.docx", doc), ("bomb.zip", bomb), kb="handbook")
    assert word["mimeType"] == f"{OOXML}.wordprocessingml.document"
    assert (rejected["status"], rejected["reason"]) == (
        "failed",
        "compressed more than 100:1 (zip bomb)",
    )
    assert wait_for(client, word["id"], settled)["status"] == "file_type_not_supported"

    [again] = upload(client, ("renamed.docx", doc), kb="handbook")
    assert (again["id"], again["duplicate"]) == (word["id"], True)


def test_users_only_see_their_records_and_deleting_frees_unshared_content(
    client: TestClient, live_settings: Settings
) -> None:
    note = b"# Notes\nonly mine"
    [mine] = upload(client, ("notes.md", note), kb="a", user="owner")
    [shared] = upload(client, ("copy.md", note), kb="b", user="owner")
    path = f"/rag/records/{mine['id']}"
    wait_for(client, mine["id"], parsed, user="owner")

    assert client.get(path, headers=bearer("intruder")).status_code == 404
    assert client.delete(path, headers=bearer("intruder")).status_code == 404
    assert client.get("/rag/records", headers=bearer("intruder")).json()["total"] == 0

    blob_key = f"owner/contents/{mine['contentId']}/original"

    def stored() -> bool:
        try:
            asyncio.run(BlobStore(live_settings).get(blob_key))
        except ClientError:
            return False
        return True

    assert client.delete(path, headers=bearer("owner")).status_code == 204
    assert client.get(path, headers=bearer("owner")).status_code == 404
    assert stored(), "the other record still holds this content"
    assert client.delete(f"/rag/records/{shared['id']}", headers=bearer("owner")).status_code == 204
    assert not stored()


def test_inspects_pdfs_and_routes_them_to_an_engine(client: TestClient) -> None:
    photo = io.BytesIO()
    picture("Invoice 2231 paid").save(photo, "PNG")
    first, second, third = upload(
        client,
        ("handbook.pdf", handbook()),
        ("scan.pdf", scanned(handbook())),
        ("photo.png", photo.getvalue()),
        kb="pdfs",
    )
    first, second, third = (
        wait_for(client, r["id"], settled, timeout_s=90) for r in (first, second, third)
    )
    # No Docling here, so the digital PDF falls back to pdfplumber; the scan and photo get OCR.
    for record in (first, second, third):
        assert parsed(record), record
    for record in (first, second):
        blocks = client.get(f"/rag/records/{record['id']}/blocks", headers=bearer("u1")).json()
        rows = [b["data"]["text"] for b in blocks["blocks"] if b["type"] == "table_row"]
        assert "Plan: Pro, Return window: 60 days, Price: $12" in rows
    blocks = client.get(f"/rag/records/{third['id']}/blocks", headers=bearer("u1")).json()
    assert blocks["engine"] == "ocr"
    assert any("Invoice 2231 paid" in str(b.get("data")) for b in blocks["blocks"])
