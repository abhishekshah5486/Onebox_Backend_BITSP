"""A vision model behind any OpenAI-compatible chat API: a local Ollama by default, or an external
provider. Used for vision OCR and for describing pictures."""

import asyncio
import hashlib
from dataclasses import dataclass
from typing import Any

import httpx

RETRY_BASE_S = 1.0


class VisionUnavailableError(Exception):
    """The model can't be reached or keeps failing: worth retrying later, or using RapidOCR."""


class VisionTruncatedError(Exception):
    """The answer hit the output limit, so part of the page is missing."""


@dataclass(frozen=True)
class VisionSettings:
    base_url: str
    model: str
    api_key: str
    timeout_s: float
    max_tokens: int
    concurrency: int
    retries: int


class VisionClient:
    def __init__(
        self, settings: VisionSettings, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.settings = settings
        headers = {"Authorization": f"Bearer {settings.api_key}"} if settings.api_key else {}
        self._http = httpx.AsyncClient(
            base_url=settings.base_url.rstrip("/"),
            headers=headers,
            timeout=httpx.Timeout(settings.timeout_s, connect=5.0),
            transport=transport,
        )
        self.slots = asyncio.Semaphore(settings.concurrency)

    def cache_key(self, prompt: str, image_uri: str) -> str:
        """Same image, model, prompt and limits: the same answer, so it is read only once."""
        parts = [self.settings.model, str(self.settings.max_tokens), prompt, image_uri]
        return hashlib.sha256("\0".join(parts).encode()).hexdigest()

    async def read(self, prompt: str, image_uri: str) -> str:
        """The model's text for one image, retried on transient failures."""
        body: dict[str, Any] = {
            "model": self.settings.model,
            "temperature": 0,
            "max_tokens": self.settings.max_tokens,
            **_model_options(self.settings.model),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_uri}},
                    ],
                }
            ],
        }
        last: Exception | None = None
        async with self.slots:
            for attempt in range(self.settings.retries + 1):
                try:
                    response = await self._http.post("/chat/completions", json=body)
                except httpx.TransportError as err:
                    last = err
                else:
                    if response.status_code == 200:
                        return _answer(response.json())
                    last = RuntimeError(f"{response.status_code}: {response.text[:200]}")
                    # Bad requests and auth won't improve on a retry.
                    if response.status_code < 500 and response.status_code != 429:
                        break
                await asyncio.sleep(min(RETRY_BASE_S * 2**attempt, 10))
        raise VisionUnavailableError(f"vision model failed ({last})") from last

    async def close(self) -> None:
        await self._http.aclose()


def _model_options(model: str) -> dict[str, Any]:
    """Qwen models think aloud by default, which spends the output on reasoning, not the page."""
    if "qwen" in model.lower():
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return {}


def _answer(payload: dict[str, Any]) -> str:
    choice = (payload.get("choices") or [{}])[0]
    if choice.get("finish_reason") == "length":
        raise VisionTruncatedError("the vision model's answer was cut off at its output limit")
    content = (choice.get("message") or {}).get("content") or ""
    if isinstance(content, list):  # some providers answer in content parts
        content = "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return str(content).strip()
