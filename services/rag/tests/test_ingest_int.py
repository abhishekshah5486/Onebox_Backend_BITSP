import asyncio
import time
from collections.abc import Iterator
from typing import Any

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from onebox_rag.app import create_app
from onebox_rag.config import Settings
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.queue import IngestQueue
from tests.test_inspect import OOXML, archive, ooxml
from tests.tokens import bearer, fake_verifier

pytestmark = pytest.mark.integration
DOCX = f"{OOXML}.wordprocessingml.document"


@pytest.fixture
def client(live_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(live_settings, verifier=fake_verifier())) as test_client:
        # Indexes and the bucket are created in the background at startup.
        deadline = time.monotonic() + 30
        while test_client.get("/health/ready").status_code != 200:
            assert time.monotonic() < deadline, "stores never became ready"
            time.sleep(0.5)
        yield test_client


def upload(
    client: TestClient, *files: tuple[str, bytes], user: str = "user-1"
) -> list[dict[str, Any]]:
    response = client.post(
        "/rag/documents",
        headers=bearer(user),
        files=[("files", (name, data, "application/octet-stream")) for name, data in files],
        data={"knowledgeBase": "handbook"},
    )
    assert response.status_code == 201, response.text
    return list(response.json()["records"])


def test_stores_queues_and_dedupes_uploads(client: TestClient, live_settings: Settings) -> None:
    doc = ooxml(f"{OOXML}.wordprocessingml.document")
    bomb = archive({"zeros.bin": b"\0" * 20 * 2**20})
    queued, rejected = upload(client, ("Leave policy.docx", doc), ("bomb.zip", bomb))

    assert queued["status"] == "queued"
    assert queued["mimeType"] == DOCX
    assert queued["sourceId"] == "handbook"
    assert rejected["status"] == "rejected"
    assert rejected["reason"] == "compressed more than 100:1 (zip bomb)"
    assert rejected["blobKey"] is None

    async def stored() -> tuple[bytes, dict[str, Any] | None, dict[str, Any] | None]:
        queue = IngestQueue(live_settings)
        try:
            return (
                await BlobStore(live_settings).get(queued["blobKey"]),
                await queue.job_data(queued["id"], 1),
                await queue.job_data(rejected["id"], 1),
            )
        finally:
            await queue.close()

    blob, job, no_job = asyncio.run(stored())
    assert blob == doc
    assert job is not None
    assert job["payload"] == {"recordId": queued["id"], "revision": 1}
    assert job["userId"] == "user-1"
    assert no_job is None

    [again] = upload(client, ("renamed.docx", doc))
    assert again["id"] == queued["id"]
    assert again["duplicate"] is True

    listed = client.get("/rag/records", headers=bearer()).json()["records"]
    assert {record["id"] for record in listed} == {queued["id"], rejected["id"]}


def test_users_only_see_and_delete_their_own_records(
    client: TestClient, live_settings: Settings
) -> None:
    [mine] = upload(client, ("notes.md", b"# Notes\nonly mine"), user="owner")
    path = f"/rag/records/{mine['id']}"

    assert client.get(path, headers=bearer("intruder")).status_code == 404
    assert client.delete(path, headers=bearer("intruder")).status_code == 404
    assert client.get("/rag/records", headers=bearer("intruder")).json() == {"records": []}

    assert client.delete(path, headers=bearer("owner")).status_code == 204
    assert client.get(path, headers=bearer("owner")).status_code == 404

    async def leftovers() -> tuple[bool, dict[str, Any] | None]:
        queue = IngestQueue(live_settings)
        try:
            await BlobStore(live_settings).get(mine["blobKey"])
            blob_left = True
        except ClientError:
            blob_left = False
        finally:
            job = await queue.job_data(mine["id"], 1)
            await queue.close()
        return blob_left, job

    assert asyncio.run(leftovers()) == (False, None)
