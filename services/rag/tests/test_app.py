import asyncio
import json
import logging

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from onebox_rag import health
from onebox_rag.app import create_app
from onebox_rag.config import Settings
from onebox_rag.logs import JsonFormatter


async def up() -> None:
    return None


async def down() -> None:
    raise ConnectionError("unreachable")


async def hangs() -> None:
    await asyncio.sleep(60)


def test_live_and_ready_when_every_dependency_answers(settings: Settings) -> None:
    with TestClient(create_app(settings, checks={"mongodb": up, "redis": up})) as client:
        assert client.get("/health/live").json() == {"status": "ok"}
        ready = client.get("/health/ready")
    assert ready.status_code == 200
    assert ready.json() == {"status": "ok", "checks": {"mongodb": "up", "redis": "up"}}


def test_not_ready_while_a_dependency_is_down_or_slow(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(health, "CHECK_TIMEOUT_S", 0.05)
    checks = {"mongodb": down, "redis": hangs, "other": up}
    with TestClient(create_app(settings, checks=checks)) as client:
        ready = client.get("/health/ready")
    assert ready.status_code == 503
    assert ready.json() == {
        "status": "unavailable",
        "checks": {"mongodb": "down", "redis": "down", "other": "up"},
    }


def test_errors_have_the_shape_the_other_services_use(settings: Settings) -> None:
    app = create_app(settings, checks={})

    class Body(BaseModel):
        email: str

    @app.post("/echo")
    async def echo(body: Body) -> Body:
        return body

    with TestClient(app) as client:
        missing = client.get("/nope")
        invalid = client.post("/echo", json={})
    assert missing.status_code == 404
    assert missing.json() == {
        "error": {"code": "NOT_FOUND", "message": "Route GET /nope not found"}
    }
    assert invalid.status_code == 400
    error = invalid.json()["error"]
    assert error["code"] == "VALIDATION_FAILED"
    assert error["details"][0]["path"] == "/email"


def test_logs_one_json_line_like_pino() -> None:
    record = logging.makeLogRecord(
        {
            "levelname": "WARNING",
            "msg": "readiness check failed",
            "checks": {"redis": "down"},
            "color_message": "\x1b[1mreadiness\x1b[0m",
        }
    )
    line = json.loads(JsonFormatter().format(record))
    assert line["level"] == "warn"
    assert line["service"] == "rag"
    assert line["msg"] == "readiness check failed"
    assert line["checks"] == {"redis": "down"}
    assert line["time"].endswith("+00:00")
    assert "color_message" not in line
