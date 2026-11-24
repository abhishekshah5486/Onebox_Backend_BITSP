"""Indexing for real: Qdrant in a container, and a stand-in llm-proxy whose vectors are
bag-of-words hashes (so texts sharing words point the same way)."""

import hashlib
import re
import socket
import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient, models

from onebox_rag.app import create_app
from onebox_rag.auth import INTERNAL_TOKEN_HEADER
from onebox_rag.config import Settings
from onebox_rag.index.embed import sparse_query
from tests.test_ingest_int import Json, upload, wait_for
from tests.tokens import bearer, fake_verifier

pytestmark = pytest.mark.integration
DIMS = 32
COLLECTION = "rag_fake_embed_v1_32"


def vector(text: str) -> list[float]:
    out = [0.0] * DIMS
    for word in re.findall(r"\w+", text.lower()):
        out[int(hashlib.md5(word.encode()).hexdigest(), 16) % DIMS] += 1.0  # noqa: S324
    return out if any(out) else [1.0] + [0.0] * (DIMS - 1)


def fake_proxy() -> FastAPI:
    app = FastAPI()

    @app.get("/internal/embed/model")
    def model() -> dict[str, Any]:
        return {"id": "fake/embed-v1", "name": "Fake", "dimensions": DIMS, "local": True}

    @app.post("/internal/embed")
    def embed(body: dict[str, Any]) -> dict[str, Any]:
        assert body["charge"] is False and len(body["texts"]) <= 64
        return {
            "model": body["model"],
            "dimensions": DIMS,
            "vectors": [vector(t) for t in body["texts"]],
        }

    @app.post("/internal/complete")
    def complete(body: dict[str, Any]) -> dict[str, Any]:
        assert body["subject"] == "rag-classify" and body["messages"][0]["role"] == "system"
        document = body["messages"][1]["content"]
        assert "File name: census.md" in document and "File type: FILE" in document
        return {
            "output": {
                "summary": "Field report on the albatross colony census for March 2026.",
                "category": "Research",
                "subcategories": {"level1": "Field report", "level2": "", "level3": ""},
                "languages": ["English"],
                "topics": ["wildlife census"],
                "organizations": ["Island Trust"],
            }
        }

    return app


@pytest.fixture(scope="module")
def proxy_url() -> Iterator[str]:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(fake_proxy(), host="127.0.0.1", port=port, log_config=None)
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(10)


@pytest.fixture
def client(live_settings: Settings, proxy_url: str) -> Iterator[TestClient]:
    settings = live_settings.model_copy(
        update={
            "RAG_LLM_PROXY_URL": proxy_url,
            "RAG_TABLE_ENRICHMENT": False,
            "RAG_CLASSIFY": False,
        }
    )
    with TestClient(create_app(settings, verifier=fake_verifier())) as test_client:
        while test_client.get("/health/ready").status_code != 200:
            time.sleep(0.5)
        yield test_client


def completed(record: Json) -> bool:
    return record["status"] not in {"queued", "in_progress"}


POLICY = b"""# Returns

## Refunds

Refunds take thirty days from delivery and go back to the original card.

## Shipping

Parcels to the islands cost 9.90 with Parcelforce.
"""


def test_indexes_blocks_as_hybrid_points_and_forgets_deleted_content(
    client: TestClient, live_settings: Settings
) -> None:
    [doc] = upload(client, ("policy.md", POLICY), kb="handbook")
    doc = wait_for(client, doc["id"], completed, timeout_s=120)
    assert doc["status"] == "completed", doc

    qdrant = QdrantClient(url=live_settings.QDRANT_URL)
    content = {"must": [{"key": "contentId", "match": {"value": doc["contentId"]}}]}
    points, _ = qdrant.scroll(COLLECTION, scroll_filter=models.Filter(**content), limit=50)
    texts = {p.payload["text"] for p in points if p.payload}
    assert "Refunds take thirty days from delivery and go back to the original card." in texts
    refund = next(p for p in points if p.payload and p.payload["text"].startswith("Refunds"))
    assert refund.payload is not None
    assert refund.payload["userId"] == "u1" and refund.payload["revision"] == 1
    assert refund.payload["headingPath"] == ["Returns", "Refunds"]

    # Both legs find it: BM25 on a word only it has, dense on its words.
    query = sparse_query("parcelforce islands")
    hits = qdrant.query_points(
        COLLECTION,
        prefetch=[
            models.Prefetch(
                query=models.SparseVector(indices=query.indices, values=query.values),
                using="sparse",
                limit=5,
            ),
            models.Prefetch(query=vector("parcels islands"), using="dense", limit=5),
        ],
        query=models.FusionQuery(fusion=models.Fusion.RRF),
        query_filter=models.Filter(
            must=[models.FieldCondition(key="userId", match=models.MatchValue(value="u1"))]
        ),
        limit=1,
        with_payload=True,
    ).points
    assert hits[0].payload is not None and "Parcelforce" in hits[0].payload["text"]

    assert client.delete(f"/rag/records/{doc['id']}", headers=bearer("u1")).status_code == 204
    left, _ = qdrant.scroll(COLLECTION, scroll_filter=models.Filter(**content), limit=50)
    assert left == []


SALES = b"region,revenue\nnorth,120\nsouth,95\neast,80\n"


def test_retrieves_cited_passages_and_reads_records_in_pages(client: TestClient) -> None:
    policy, sales = upload(client, ("policy.md", POLICY), ("sales.csv", SALES), kb="handbook")
    [other] = upload(client, ("other.md", b"# Parcels\n\nParcelforce islands note."), kb="misc")
    for record in (policy, sales, other):
        assert wait_for(client, record["id"], completed, timeout_s=120)["status"] == "completed"

    def retrieve(**body: object) -> list[Json]:
        response = client.post("/rag/retrieve", json=body, headers=bearer("u1"))
        assert response.status_code == 200, response.text
        return list(response.json()["chunks"])

    [first, *_] = retrieve(query="parcelforce islands", sourceIds=["handbook"])
    assert "Parcelforce" in first["text"] and first["record"]["recordId"] == policy["id"]
    # A short record may come whole, found by its title as well (cited from its first block).
    if first["kind"] != "record":
        assert first["citation"]["headingPath"] == ["Returns", "Shipping"]
    assert {
        c["record"]["recordId"] for c in retrieve(query="parcelforce", recordIds=[other["id"]])
    } == {other["id"]}

    table = next(
        c
        for c in retrieve(query="south revenue 95", sourceIds=["handbook"])
        if c["kind"] == "table"
    )
    assert "region: south, revenue: 95" in table["text"]
    assert table["record"]["recordId"] == sales["id"]
    assert retrieve(query="refunds", sourceIds=["nothing-here"]) == []
    assert retrieve(query="refunds")
    other_user = client.post("/rag/retrieve", json={"query": "refunds"}, headers=bearer("u2"))
    assert other_user.json()["chunks"] == []

    page = client.get(f"/rag/records/{sales['id']}/read?max=2", headers=bearer("u1")).json()
    assert [b["text"] for b in page["blocks"]] == [
        "region | revenue",
        "region: north, revenue: 120",
    ]
    assert page["next"] == 2 and page["groups"][0]["type"] == "table"
    rest = client.get(f"/rag/records/{sales['id']}/read?start=2", headers=bearer("u1")).json()
    assert rest["next"] is None and len(rest["blocks"]) == 2

    internal = {"query": "parcelforce", "userId": "u1"}
    assert client.post("/internal/rag/retrieve", json=internal).status_code == 401
    token = {INTERNAL_TOKEN_HEADER: client.app.state.internal_token}  # type: ignore[attr-defined]
    response = client.post("/internal/rag/retrieve", json=internal, headers=token)
    assert response.status_code == 200 and response.json()["chunks"]


def test_finds_records_by_name_and_names_the_unreadable(
    client: TestClient, live_settings: Settings
) -> None:
    [budget, minutes] = upload(
        client,
        ("Quarterly budget.md", b"Spend stays flat until spring."),
        ("Board minutes.dat", bytes(range(256)) * 8),
        kb="names",
    )
    wait_for(client, budget["id"], completed, timeout_s=120)
    wait_for(client, minutes["id"], lambda r: r["status"] != "queued", timeout_s=60)

    def ask(query: str) -> Json:
        response = client.post("/rag/retrieve", json={"query": query}, headers=bearer("u1"))
        return dict(response.json())

    # Its name says what its text doesn't: found by name, short, so shown whole.
    found = ask("quarterly budget")
    record = next(c for c in found["chunks"] if c["record"]["recordId"] == budget["id"])
    assert record["kind"] == "record"
    assert record["text"] == "Name: Quarterly budget.md\n\nSpend stays flat until spring."
    # Read with a question, a short record comes whole.
    read = client.get(
        f"/rag/records/{budget['id']}/read", params={"query": "spend"}, headers=bearer("u1")
    ).json()
    assert read["focused"] and read["gaps"] == [] and read["next"] is None
    assert [b["text"] for b in read["blocks"]] == ["Spend stays flat until spring."]
    # A file that can't be read is still found by name, named apart from the passages.
    [unread] = [u for u in ask("board minutes")["unindexed"] if u["recordId"] == minutes["id"]]
    assert unread["name"] == "Board minutes.dat" and unread["status"] != "completed"

    qdrant = QdrantClient(url=live_settings.QDRANT_URL)
    title = models.Filter(
        must=[models.FieldCondition(key="recordId", match=models.MatchValue(value=minutes["id"]))]
    )
    assert qdrant.count(COLLECTION, count_filter=title).count == 1
    assert client.delete(f"/rag/records/{minutes['id']}", headers=bearer("u1")).status_code == 204
    assert qdrant.count(COLLECTION, count_filter=title).count == 0


def test_says_what_a_search_could_not_see(live_settings: Settings, proxy_url: str) -> None:
    base = {"RAG_LLM_PROXY_URL": proxy_url, "RAG_TABLE_ENRICHMENT": False, "RAG_CLASSIFY": False}
    # Nothing reads uploads: they stay waiting, named by title, counted as unread.
    idle = live_settings.model_copy(update={**base, "RAG_RUN_WORKER": False})
    with TestClient(create_app(idle, verifier=fake_verifier())) as client:
        while client.get("/health/ready").status_code != 200:
            time.sleep(0.5)
        [plan] = upload(client, ("Launch plan.md", b"Ship it in March."), kb="waiting", user="u9")
        found = client.post(
            "/rag/retrieve",
            json={"query": "launch plan", "sourceIds": ["waiting"]},
            headers=bearer("u9"),
        ).json()
        assert found["chunks"] == []
        assert [u["recordId"] for u in found["unindexed"]] == [plan["id"]]
        assert found["notices"][0]["code"] == "STILL_READING" and found["notices"][0]["count"] == 1

    # The index down: an error that says so, never an empty result.
    down = live_settings.model_copy(update={**base, "QDRANT_URL": "http://127.0.0.1:9"})
    with TestClient(create_app(down, verifier=fake_verifier())) as client:
        response = client.post("/rag/retrieve", json={"query": "x"}, headers=bearer("u9"))
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "SEARCH_INDEX_UNREACHABLE"


def test_an_upload_is_dated_by_its_files_last_modified_time(client: TestClient) -> None:
    march = 1_709_424_000_000  # 2024-03-03T00:00:00Z
    files = [
        ("files", ("invoice.md", b"Invoice for harbour fees.", "text/markdown")),
        ("files", ("notes.md", b"Harbour notes, undated.", "text/markdown")),
    ]
    response = client.post(
        "/rag/documents",
        headers=bearer("u7"),
        files=files,
        data={"knowledgeBase": "dated", "lastModified": [str(march), "0"]},
    )
    assert response.status_code == 201, response.text
    invoice, notes = response.json()["records"]
    assert (
        invoice["sourceCreatedAt"].startswith("2024-03-03")
        and invoice["dateOrigin"] == "lastModified"
    )
    assert notes["dateOrigin"] == "upload"
    mismatched = client.post(
        "/rag/documents",
        headers=bearer("u7"),
        files=files,
        data={"lastModified": [str(march)]},
    )
    assert mismatched.status_code == 400

    for record in (invoice, notes):
        wait_for(client, record["id"], completed, user="u7", timeout_s=120)
    found = client.post(
        "/rag/retrieve",
        json={"query": "harbour", "createdAfter": "2024-03-01", "createdBefore": "2024-03-31"},
        headers=bearer("u7"),
    ).json()
    assert {c["record"]["recordId"] for c in found["chunks"]} == {invoice["id"]}


def test_an_upload_takes_the_date_its_header_states(
    live_settings: Settings, proxy_url: str
) -> None:
    settings = live_settings.model_copy(
        update={
            "RAG_LLM_PROXY_URL": proxy_url,
            "RAG_TABLE_ENRICHMENT": False,
            "RAG_CONTENT_DOCUMENT_DATES": "true",
            "RAG_CLASSIFY": False,
        }
    )
    with TestClient(create_app(settings, verifier=fake_verifier())) as client:
        while client.get("/health/ready").status_code != 200:
            time.sleep(0.5)
        memo, kept = upload(
            client,
            ("memo.md", b"Date: March 3, 2025\n\nThe lighthouse budget is approved."),
            ("plain.md", b"Lighthouse keeper rota."),
            kb="memos",
            user="u8",
        )
        memo = wait_for(
            client, memo["id"], lambda r: r.get("dateOrigin") == "content", user="u8", timeout_s=120
        )
        assert memo["sourceCreatedAt"].startswith("2025-03-03")
        assert memo["uploadDateOrigin"] == "upload"
        kept = wait_for(client, kept["id"], completed, user="u8", timeout_s=120)
        assert kept["dateOrigin"] == "upload"

        # Dated only by its upload, the other may have been written in March too.
        def dated(*record_ids: str) -> bool:
            found = client.post(
                "/rag/retrieve",
                json={
                    "query": "lighthouse",
                    "createdAfter": "2025-03-01",
                    "createdBefore": "2025-03-31",
                },
                headers=bearer("u8"),
            ).json()
            return {c["record"]["recordId"] for c in found["chunks"]} == set(record_ids)

        deadline = time.monotonic() + 30
        while not dated(memo["id"], kept["id"]):
            assert time.monotonic() < deadline
            time.sleep(0.5)


def test_a_dated_search_lists_matches_its_dates_left_out(client: TestClient) -> None:
    march, april = 1_709_424_000_000, 1_712_102_400_000  # 2024-03-03, 2024-04-03
    response = client.post(
        "/rag/documents",
        headers=bearer("u6"),
        files=[
            ("files", ("standup.md", b"Ferry timetable standup notes.", "text/markdown")),
            ("files", ("retro.md", b"Ferry timetable retrospective for March.", "text/markdown")),
        ],
        data={"knowledgeBase": "ferry", "lastModified": [str(march), str(april)]},
    )
    standup, retro = response.json()["records"]
    for record in (standup, retro):
        wait_for(client, record["id"], completed, user="u6", timeout_s=120)

    def search(**dates: str) -> Json:
        return dict(
            client.post(
                "/rag/retrieve", json={"query": "ferry timetable", **dates}, headers=bearer("u6")
            ).json()
        )

    found = search(createdAfter="2024-03-01", createdBefore="2024-03-31")
    assert {c["record"]["recordId"] for c in found["chunks"]} == {standup["id"]}
    outside = found["outsideDates"]
    assert {c["record"]["recordId"] for c in outside["chunks"]} == {retro["id"]}
    assert outside["chunks"][0]["record"]["dates"]["created"].startswith("2024-04-03")
    assert outside["chunks"][0]["record"]["dates"]["origin"] == "lastModified"
    assert "outsideDates" not in search()


def test_a_record_is_summarized_and_found_by_its_summary(
    live_settings: Settings, proxy_url: str
) -> None:
    settings = live_settings.model_copy(
        update={"RAG_LLM_PROXY_URL": proxy_url, "RAG_TABLE_ENRICHMENT": False}
    )
    with TestClient(create_app(settings, verifier=fake_verifier())) as client:
        while client.get("/health/ready").status_code != 200:
            time.sleep(0.5)
        [census] = upload(
            client, ("census.md", b"Nests counted on the north cliffs: 412."), kb="birds", user="u5"
        )

        def classified(record: Json) -> bool:
            detail = client.get(f"/rag/records/{record['id']}", headers=bearer("u5")).json()
            return bool(detail.get("classifyStatus") == "completed")

        wait_for(client, census["id"], classified, user="u5", timeout_s=120)
        detail = client.get(f"/rag/records/{census['id']}", headers=bearer("u5")).json()
        assert detail["classification"]["topics"] == ["wildlife census"]
        assert detail["classification"]["organizations"] == ["Island Trust"]

        # Its text never says "albatross"; its summary does.
        found = client.post(
            "/rag/retrieve", json={"query": "albatross"}, headers=bearer("u5")
        ).json()
        summary = next(c for c in found["chunks"] if c["kind"] == "summary")
        assert summary["record"]["recordId"] == census["id"]
        assert summary["text"].startswith("Field report on the albatross colony census")
