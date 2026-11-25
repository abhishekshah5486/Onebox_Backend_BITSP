"""Reads stored mail from the mail service's internal routes."""

from typing import Any

import httpx

from onebox_rag.auth import INTERNAL_TOKEN_HEADER


class MailUnavailableError(Exception):
    """The mail service failed; the job is retried."""


class MailClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        timeout_s: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(timeout_s, connect=5.0),
            headers={INTERNAL_TOKEN_HEADER: token},
            transport=transport,
        )

    async def message(self, user_id: str, message_id: str) -> dict[str, Any] | None:
        """The stored copy, or None once it is gone."""
        response = await self._get(f"/internal/messages/{message_id}", user_id)
        if response is None:
            return None
        body: dict[str, Any] = response.json()
        return body

    async def attachment(self, user_id: str, message_id: str, index: int) -> bytes | None:
        """Its contents, or None when the mail server no longer has them."""
        response = await self._get(f"/internal/messages/{message_id}/attachments/{index}", user_id)
        return response.content if response is not None else None

    async def copies(
        self, user_id: str, account_id: str, message_id_header: str
    ) -> tuple[list[str], list[str]]:
        """Every copy of an email the mailbox holds now, and those not in spam, trash or drafts."""
        response = await self._http.get(
            f"/internal/accounts/{account_id}/copies",
            params={"userId": user_id, "messageIdHeader": message_id_header},
        )
        if response.status_code != 200:
            raise MailUnavailableError(f"mail answered {response.status_code}")
        body = response.json()
        return list(body["held"]), list(body["readable"])

    async def _get(self, path: str, user_id: str) -> httpx.Response | None:
        try:
            response = await self._http.get(path, params={"userId": user_id})
        except httpx.TransportError as err:
            raise MailUnavailableError(f"mail unreachable ({type(err).__name__})") from err
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise MailUnavailableError(f"mail answered {response.status_code}")
        return response

    async def close(self) -> None:
        await self._http.aclose()
