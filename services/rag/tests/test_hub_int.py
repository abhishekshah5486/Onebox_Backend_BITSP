from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.test_ingest_int import Json, client  # noqa: F401 - a fixture
from tests.tokens import bearer

pytestmark = pytest.mark.integration

USER = bearer("hub")


def names(api: TestClient, **params: Any) -> list[str]:
    found = api.get("/rag/records", params={"sourceType": "upload", **params}, headers=USER)
    return sorted(r["name"] for r in found.json()["records"])


def test_collections_folders_and_the_trash(client: TestClient) -> None:  # noqa: F811
    # Uploading to a collection by its old-style id makes it, named after it.
    first = client.post(
        "/rag/documents",
        headers=USER,
        files=[("files", ("a.txt", b"alpha", "text/plain"))],
        data={"knowledgeBase": "default"},
    )
    assert first.status_code == 201
    listed = client.get("/rag/collections", headers=USER).json()["collections"]
    assert [(c["id"], c["name"]) for c in listed] == [("default", "My files")]

    made = client.post("/rag/collections", json={"name": "Reports"}, headers=USER)
    assert made.status_code == 201
    kb = made.json()["id"]
    clash = client.post("/rag/collections", json={"name": " reports "}, headers=USER)
    assert clash.status_code == 409

    folder = client.post(
        f"/rag/collections/{kb}/folders", json={"name": "2024"}, headers=USER
    ).json()
    assert folder["depth"] == 1
    bad = client.post(f"/rag/collections/{kb}/folders", json={"name": "a/b"}, headers=USER)
    assert bad.status_code == 400
    again = client.post(f"/rag/collections/{kb}/folders", json={"name": "2024"}, headers=USER)
    assert again.status_code == 409

    # A folder upload makes the folders in its paths, inside the target folder.
    uploaded = client.post(
        "/rag/documents",
        headers=USER,
        files=[
            ("files", ("q1.txt", b"first quarter", "text/plain")),
            ("files", ("q2.txt", b"second quarter", "text/plain")),
        ],
        data={"knowledgeBase": kb, "folderId": folder["id"], "paths": ["Q/q1.txt", "q2.txt"]},
    ).json()["records"]
    q1, q2 = uploaded
    assert q2["folderId"] == folder["id"] and q1["folderId"] not in {None, folder["id"]}
    assert q1["recordType"] == "FILE" and q1["origin"] == "UPLOAD"
    assert names(client, folderId=folder["id"]) == ["q2.txt"]

    # Names are unique within a folder.
    moved = client.post(
        f"/rag/records/{q1['id']}/move",
        json={"collectionId": kb, "folderId": folder["id"]},
        headers=USER,
    )
    assert moved.status_code == 200
    renamed = client.patch(f"/rag/records/{q1['id']}", json={"name": "Q2.TXT"}, headers=USER)
    assert renamed.status_code == 409
    renamed = client.patch(f"/rag/records/{q1['id']}", json={"name": "march.txt"}, headers=USER)
    assert renamed.json()["name"] == "march.txt"
    assert names(client, folderId=folder["id"]) == ["march.txt", "q2.txt"]

    # Deleting goes to the trash, and restoring brings it back.
    assert client.delete(f"/rag/records/{q2['id']}", headers=USER).status_code == 204
    assert names(client, folderId=folder["id"]) == ["march.txt"]
    assert names(client, trashed="true") == ["q2.txt"]
    restored = client.post("/rag/records/restore", json={"ids": [q2["id"]]}, headers=USER)
    assert restored.json()["restored"] == [q2["id"]]

    # A deleted folder's files go to the trash and come back to the top of the collection.
    gone = client.delete(f"/rag/collections/{kb}/folders/{folder['id']}", headers=USER)
    assert gone.json()["trashed"] == 2
    assert names(client, sourceId=kb) == []
    client.post("/rag/records/restore", json={"ids": [q1["id"], q2["id"]]}, headers=USER)
    assert names(client, sourceId=kb, folderId="root") == ["march.txt", "q2.txt"]

    assert client.delete(f"/rag/collections/{kb}", headers=USER).status_code == 204
    assert names(client) == ["a.txt"]
    assert client.get(f"/rag/records/{q1['id']}", headers=USER).status_code == 404


def test_one_users_collections_are_their_own(client: TestClient) -> None:  # noqa: F811
    kb = client.post("/rag/collections", json={"name": "Mine"}, headers=USER).json()["id"]
    other = bearer("someone-else")
    assert client.post("/rag/collections", json={"name": "Mine"}, headers=other).status_code == 201
    created = client.post(f"/rag/collections/{kb}/folders", json={"name": "x"}, headers=other)
    assert created.status_code == 404
    record: Json = client.post(
        "/rag/documents",
        headers=USER,
        files=[("files", ("own.txt", b"own", "text/plain"))],
        data={"knowledgeBase": kb},
    ).json()["records"][0]
    assert (
        client.patch(f"/rag/records/{record['id']}", json={"name": "x"}, headers=other).status_code
        == 404
    )
