import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import Request, Response

SERVICE = "rag"
QUIET_ROUTES = {"/health/live", "/health/ready"}
# Attributes every LogRecord has; anything else was passed through `extra` and is logged.
_STANDARD = set(vars(logging.makeLogRecord({}))) | {"message", "asctime", "taskName"}
# Uvicorn's terminal-coloured copy of the message.
_DROPPED = {"color_message"}


class JsonFormatter(logging.Formatter):
    """One JSON object per line, shaped like the TypeScript services' pino logs."""

    def __init__(self, service: str = SERVICE) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "level": record.levelname.lower().replace("warning", "warn"),
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "service": self.service,
            "msg": record.getMessage(),
        }
        entry.update(
            {k: v for k, v in vars(record).items() if k not in _STANDARD and k not in _DROPPED}
        )
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, separators=(",", ":"))


def configure_logging(level: str, service: str = SERVICE) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    # Requests are logged by the middleware below instead.
    logging.getLogger("uvicorn.access").disabled = True


request_logger = logging.getLogger("onebox_rag.http")


async def log_requests(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    started = time.perf_counter()
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    response = await call_next(request)
    response.headers["x-request-id"] = request_id
    if request.url.path not in QUIET_ROUTES:
        request_logger.info(
            "request completed",
            extra={
                "requestId": request_id,
                "method": request.method,
                "url": request.url.path,
                "statusCode": response.status_code,
                "durationMs": round((time.perf_counter() - started) * 1000),
            },
        )
    return response
