"""The mail source for real: jobs on rag-mail, a stand-in mail service, then parsing, indexing
and retrieval as for any record."""

import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest
import uvicorn
from bullmq import Queue
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from onebox_rag.app import create_app
from onebox_rag.config import Settings
from tests.test_index_int import proxy_url  # noqa: F401 - a fixture
from tests.test_ingest_int import Json
from tests.tokens import bearer, fake_verifier

pytestmark = pytest.mark.integration

REPLY_HTML = (
    "<div>Parcels to the islands go with Parcelforce from Monday.</div>"
    '<div class="gmail_quote">On Fri, Bob wrote:<blockquote>Which courier for the islands?'
    "</blockquote></div>"
)
EMAIL = {
    "id": "m-inbox",
    "accountId": "acct-1",
    "threadId": "t-1",
    "messageIdHeader": "<m1@acme>",
    "subject": "Island shipping",
    "from": {"name": "Ana", "address": "ana@acme.test"},
    "to": [{"name": "", "address": "me@onebox.test"}],
    "cc": [],
    "receivedAt": "2026-11-20T09:30:00.000Z",
    "sentAt": None,
    "textBody": "Parcels to the islands go with Parcelforce from Monday.",
    "htmlBody": REPLY_HTML,
    "attachments": [
        {
            "index": 0,
            "filename": "rates.csv",
            "contentType": "text/csv",
            "sizeBytes": 40,
            "inline": False,
            "sha256": None,
        },
    ],
}
RATES = b"zone,price\nislands,9.90\nmainland,4.50\n"


def fake_mail(calls: list[str]) -> FastAPI:
    app = FastAPI()

    @app.get("/internal/messages/{message_id}")
    def message(message_id: str, userId: str) -> Any:
        calls.append(message_id)
        if userId != "u1" or message_id not in {"m-inbox", "m-label"}:
            return Response(status_code=404)
        return {**EMAIL, "id": message_id}

    @app.get("/internal/messages/{message_id}/attachments/{index}")
    def attachment(message_id: str, index: int) -> Response:
        calls.append(f"{message_id}/{index}")
        return Response(RATES, media_type="application/octet-stream")

    return app


@pytest.fixture(scope="module")
def mail() -> Iterator[tuple[str, list[str]]]:
    calls: list[str] = []
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(fake_mail(calls), host="127.0.0.1", port=port, log_config=None)
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}", calls
    server.should_exit = True
    thread.join(10)


@pytest.fixture
def client(
    live_settings: Settings,
    proxy_url: str,  # noqa: F811
    mail: tuple[str, list[str]],
) -> Iterator[TestClient]:
    settings = live_settings.model_copy(
        update={
            "RAG_LLM_PROXY_URL": proxy_url,
            "RAG_TABLE_ENRICHMENT": False,
            "RAG_MAIL_URL": mail[0],
        }
    )
    with TestClient(create_app(settings, verifier=fake_verifier())) as test_client:
        while test_client.get("/health/ready").status_code != 200:
            time.sleep(0.5)
        yield test_client


def until(check: Any, timeout_s: float = 120) -> Any:
    deadline = time.monotonic() + timeout_s
    while True:
        value = check()
        if value:
            return value
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.3)


def test_keeps_emails_and_attachments_in_step_with_the_mailbox(
    client: TestClient, live_settings: Settings, mail: tuple[str, list[str]]
) -> None:
    queue = Queue("rag-mail", {"connection": live_settings.REDIS_URL})
    calls = mail[1]
    job = 0

    def send(payload: dict[str, Any], user: str = "u1") -> None:
        nonlocal job
        job += 1
        envelope = {
            "jobId": f"j{job}",
            "userId": user,
            "traceId": "t",
            "attempt": 1,
            "enqueuedAt": "2026-11-23T00:00:00.000Z",
            "schemaVersion": 1,
            "payload": payload,
        }
        client.portal.call(queue.add, "rag-mail", envelope, {"jobId": f"j{job}"})  # type: ignore[union-attr]

    def mail_records() -> list[Json]:
        response = client.get("/rag/records?sourceType=mail", headers=bearer("u1"))
        return list(response.json()["records"])

    def the_email() -> Json:
        return next(r for r in mail_records() if r["parentId"] is None)

    def settled() -> list[Json] | None:
        found = mail_records()
        done = len(found) == 2 and all(r["status"] == "completed" for r in found)
        return found if done else None

    upsert = {"op": "upsert", "key": "k1", "accountId": "acct-1"}
    send({**upsert, "version": 1, "messageIds": ["m-inbox"]})
    email, rates = sorted(until(settled), key=lambda r: r["parentId"] is not None)
    assert email["name"] == "Island shipping" and rates["parentId"] == email["id"]
    assert email["mail"]["copyIds"] == ["m-inbox"]
    assert email["mail"]["sender"] == {"name": "Ana", "address": "ana@acme.test"}
    texts = [
        b.get("data")
        for b in client.get(f"/rag/records/{email['id']}/blocks", headers=bearer("u1")).json()[
            "blocks"
        ]
    ]
    # Only the reply; the quoted question lives in its own email.
    assert any("Parcelforce" in str(t) for t in texts)
    assert not any("Which courier" in str(t) for t in texts)

    chunks = client.post(
        "/rag/retrieve", json={"query": "islands parcelforce"}, headers=bearer("u1")
    ).json()["chunks"]
    by_record = {c["record"]["recordId"]: c["record"] for c in chunks}
    assert by_record[email["id"]]["mail"]["receivedAt"] == "2026-11-20T09:30:00Z"
    if rates["id"] in by_record:
        assert by_record[rates["id"]]["attachedTo"]["recordId"] == email["id"]

    # A copy in another folder: no new reading, only the copies change.
    reads = len(calls)
    send({**upsert, "version": 2, "messageIds": ["m-inbox", "m-label"]})
    until(lambda: the_email()["mail"]["version"] == 2)
    assert len(calls) == reads
    # An older change arriving late changes nothing.
    send({**upsert, "version": 1, "messageIds": ["m-inbox"]})
    send({"op": "delete", "version": 3, "messageId": "m-label"})
    until(lambda: the_email()["mail"]["copyIds"] == ["m-inbox"])

    # The last copy goes: the email and its attachment leave RAG.
    send({"op": "delete", "version": 4, "messageId": "m-inbox"}, user="system")
    until(lambda: mail_records() == [])

    # Moved to spam (no copy RAG reads): removed too.
    send({**upsert, "key": "k2", "version": 5, "messageIds": ["m-inbox"]})
    until(lambda: len(mail_records()) == 2)
    send({"op": "remove", "key": "k2", "accountId": "acct-1", "version": 6})
    until(lambda: mail_records() == [])
    client.portal.call(queue.close)  # type: ignore[union-attr]
