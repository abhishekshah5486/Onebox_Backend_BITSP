from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from testcontainers.community.redis import RedisContainer
from testcontainers.mongodb import MongoDbContainer

from onebox_rag.app import create_app
from onebox_rag.config import Settings

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def infra() -> Iterator[tuple[str, str]]:
    with MongoDbContainer("mongo:8.0") as mongo, RedisContainer("redis:8.10.2-alpine") as redis:
        host, port = redis.get_container_host_ip(), redis.get_exposed_port(6379)
        yield mongo.get_connection_url(), f"redis://{host}:{port}"


def test_ready_once_mongodb_and_redis_answer(settings: Settings, infra: tuple[str, str]) -> None:
    mongo_uri, redis_url = infra
    app = create_app(settings.model_copy(update={"MONGO_URI": mongo_uri, "REDIS_URL": redis_url}))
    with TestClient(app) as client:
        ready = client.get("/health/ready")
    assert ready.json() == {"status": "ok", "checks": {"mongodb": "up", "redis": "up"}}


def test_not_ready_when_they_are_unreachable(settings: Settings) -> None:
    unreachable = settings.model_copy(
        update={
            "MONGO_URI": "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500",
            "REDIS_URL": "redis://127.0.0.1:1",
        }
    )
    with TestClient(create_app(unreachable)) as client:
        ready = client.get("/health/ready")
    assert ready.status_code == 503
    assert ready.json()["checks"] == {"mongodb": "down", "redis": "down"}
