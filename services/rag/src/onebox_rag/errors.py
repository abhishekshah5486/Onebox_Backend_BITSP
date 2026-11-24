import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("onebox_rag.errors")


class AppError(Exception):
    """An error a client can act on, sent as {"error": {"code", "message"}} like the other
    services (packages/errors)."""

    status_code = 500
    default_code = "INTERNAL"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code or self.default_code


class ValidationError(AppError):
    status_code = 400
    default_code = "VALIDATION_FAILED"


class UnauthorizedError(AppError):
    status_code = 401
    default_code = "UNAUTHORIZED"


class NotFoundError(AppError):
    status_code = 404
    default_code = "NOT_FOUND"


class ConflictError(AppError):
    status_code = 409
    default_code = "CONFLICT"


class UnavailableError(AppError):
    status_code = 503
    default_code = "UNAVAILABLE"


def _body(code: str, message: str, details: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return {"error": error}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(_: Request, err: AppError) -> JSONResponse:
        return JSONResponse(_body(err.code, err.message), status_code=err.status_code)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, err: RequestValidationError) -> JSONResponse:
        details = [
            {
                "path": "/" + "/".join(str(part) for part in issue["loc"][1:]),
                "message": issue["msg"],
            }
            for issue in err.errors()
        ]
        body = _body("VALIDATION_FAILED", "Request validation failed", details)
        return JSONResponse(body, status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, err: StarletteHTTPException) -> JSONResponse:
        if err.status_code == 404:
            message = f"Route {request.method} {request.url.path} not found"
            return JSONResponse(_body("NOT_FOUND", message), status_code=404)
        return JSONResponse(_body("BAD_REQUEST", str(err.detail)), status_code=err.status_code)

    # Anything unexpected is logged and masked as a 500.
    @app.exception_handler(Exception)
    async def unexpected(request: Request, err: Exception) -> JSONResponse:
        logger.error("request failed", exc_info=err, extra={"url": request.url.path})
        return JSONResponse(_body("INTERNAL", "Something went wrong"), status_code=500)
