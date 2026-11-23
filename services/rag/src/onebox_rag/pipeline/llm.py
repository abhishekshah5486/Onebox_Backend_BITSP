"""Text models through OneBox's llm-proxy, which picks the user's model, bills it and caches it."""

from typing import Any

import httpx

from onebox_rag.auth import INTERNAL_TOKEN_HEADER


class LlmUnavailableError(Exception):
    """The proxy or its model failed; the caller falls back to plain text."""


class OutOfCreditsError(LlmUnavailableError):
    """The user has no AI credits left: no point asking again for this file."""


class LlmClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        timeout_s: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._token = token
        self._http = httpx.AsyncClient(
            base_url=base_url, timeout=httpx.Timeout(timeout_s, connect=5.0), transport=transport
        )

    async def json(
        self,
        user_id: str,
        messages: list[dict[str, str]],
        schema_name: str,
        schema: dict[str, Any],
        *,
        max_output_tokens: int,
    ) -> Any:
        """The model's answer as JSON matching `schema` (the proxy validates it)."""
        body = {
            "userId": user_id,
            "purpose": "summarize",
            "messages": messages,
            "schema": {"name": schema_name, "schema": schema},
            "maxOutputTokens": max_output_tokens,
            "temperature": 0,
            "cache": True,
            "subject": "rag-tables",
        }
        try:
            response = await self._http.post(
                "/internal/complete", json=body, headers={INTERNAL_TOKEN_HEADER: self._token}
            )
        except httpx.TransportError as err:
            raise LlmUnavailableError(f"llm-proxy unreachable ({type(err).__name__})") from err
        if response.status_code == 402:
            raise OutOfCreditsError("the user is out of AI credits")
        if response.status_code != 200:
            raise LlmUnavailableError(f"llm-proxy answered {response.status_code}")
        return response.json().get("output")

    async def close(self) -> None:
        await self._http.aclose()
