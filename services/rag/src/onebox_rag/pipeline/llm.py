"""Text models through OneBox's llm-proxy, which picks the user's model, bills it and caches it."""

from typing import Any

import httpx

from onebox_rag.auth import INTERNAL_TOKEN_HEADER


class LlmUnavailableError(Exception):
    """The proxy or its model failed; the caller falls back to plain text."""


class OutOfCreditsError(LlmUnavailableError):
    """The user has no AI credits left: no point asking again for this file."""


class InvalidOutputError(LlmUnavailableError):
    """Models answered, but never in the required format: asking for less may work."""


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
        subject: str = "rag-tables",
    ) -> Any:
        """The model's answer as JSON matching `schema` (the proxy validates it)."""
        return await self._complete(
            user_id,
            messages,
            {"schema": {"name": schema_name, "schema": schema}},
            max_output_tokens=max_output_tokens,
            subject=subject,
        )

    async def text(
        self,
        user_id: str,
        messages: list[dict[str, str]],
        *,
        max_output_tokens: int,
        subject: str,
    ) -> str:
        output = await self._complete(
            user_id, messages, {}, max_output_tokens=max_output_tokens, subject=subject
        )
        return output if isinstance(output, str) else ""

    async def _complete(
        self,
        user_id: str,
        messages: list[dict[str, str]],
        extra: dict[str, Any],
        *,
        max_output_tokens: int,
        subject: str,
    ) -> Any:
        body = {
            "userId": user_id,
            "purpose": "summarize",
            "messages": messages,
            "maxOutputTokens": max_output_tokens,
            "temperature": 0,
            "cache": True,
            "subject": subject,
            **extra,
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
            if _error_code(response) == "INVALID_OUTPUT":
                raise InvalidOutputError("no model answered in the required format")
            raise LlmUnavailableError(f"llm-proxy answered {response.status_code}")
        return response.json().get("output")

    async def close(self) -> None:
        await self._http.aclose()


def _error_code(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    error = body.get("error") if isinstance(body, dict) else None
    return error.get("code") if isinstance(error, dict) else None
