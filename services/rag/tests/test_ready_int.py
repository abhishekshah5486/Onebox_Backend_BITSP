import time

import pytest
from fastapi.testclient import TestClient

from onebox_rag.app import create_app
from onebox_rag.config import Settings

pytestmark = pytest.mark.integration


def test_ready_once_its_stores_answer(live_settings: Settings) -> None:
    # A fresh container's first ping can outlast one check, so wait as a load balancer would.
    with TestClient(create_app(live_settings)) as client:
        deadline = time.monotonic() + 30
        ready = client.get("/health/ready")
        while ready.status_code != 200 and time.monotonic() < deadline:
            time.sleep(0.5)
            ready = client.get("/health/ready")
    assert ready.json() == {
        "status": "ok",
        "checks": {"mongodb": "up", "redis": "up", "blobs": "up"},
    }


def test_not_ready_when_they_are_unreachable(settings: Settings) -> None:
    unreachable = settings.model_copy(
        update={
            "MONGO_URI": "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500",
            "REDIS_URL": "redis://127.0.0.1:1",
            "BLOB_ENDPOINT": "http://127.0.0.1:1",
        }
    )
    with TestClient(create_app(unreachable)) as client:
        ready = client.get("/health/ready")
    assert ready.status_code == 503
    assert ready.json()["checks"] == {"mongodb": "down", "redis": "down", "blobs": "down"}
