from typing import Any

import httpx

from onebox_rag.auth import INTERNAL_TOKEN_HEADER
from onebox_rag.parsers.base import UnreadableFileError
from onebox_rag.parsers.office import OfficeFormat
from onebox_rag.pipeline.pool import ParseWorkerError


class DoclingUnavailableError(Exception):
    """The Docling service is down, busy or restarting: worth retrying later."""


class DoclingClient:
    def __init__(self, base_url: str, token: str, timeout_s: float) -> None:
        self._token = token
        self._http = httpx.AsyncClient(
            base_url=base_url, timeout=httpx.Timeout(timeout_s, connect=5.0)
        )

    async def convert(self, data: bytes, office: OfficeFormat, name: str) -> dict[str, Any]:
        form = {"target": office.docling}
        if office.legacy_ext:
            form["legacyExt"] = office.legacy_ext
        try:
            response = await self._http.post(
                "/convert",
                files={"file": (name, data)},
                data=form,
                headers={INTERNAL_TOKEN_HEADER: self._token},
            )
        except httpx.TransportError as err:
            raise DoclingUnavailableError(f"Docling unreachable ({type(err).__name__})") from err
        if response.status_code == 200:
            document: dict[str, Any] = response.json()
            return document
        code, reason = _problem(response)
        # Its workers fail the way ours do, so the parse stage treats them the same.
        if code == "TIMED_OUT":
            raise ParseWorkerError("timed_out", reason)
        if code == "WORKER_KILLED":
            raise ParseWorkerError("killed", reason)
        if response.status_code == 422:
            raise UnreadableFileError(reason)
        raise DoclingUnavailableError(f"Docling answered {response.status_code}: {reason}")

    async def ping(self) -> None:
        (await self._http.get("/health/ready")).raise_for_status()

    async def close(self) -> None:
        await self._http.aclose()


def _problem(response: httpx.Response) -> tuple[str, str]:
    try:
        body = response.json()
        return str(body.get("code", "")), str(body.get("reason") or body.get("message") or "")
    except ValueError:
        return "", response.text[:200]
