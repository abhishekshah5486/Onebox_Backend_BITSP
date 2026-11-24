import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.records import ContentStore
from onebox_rag.models import Content
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.ocr.rapid import OcrLimits, parse_image, parse_scanned_pdf
from onebox_rag.parsers.ocr.vision_ocr import pages_to_blocks, render_pages
from onebox_rag.pipeline.pool import ParsePool
from onebox_rag.pipeline.prompts import OCR_PROMPT
from onebox_rag.pipeline.routing import PDF
from onebox_rag.pipeline.vision import VisionClient, VisionTruncatedError, VisionUnavailableError

logger = logging.getLogger("onebox_rag.ocr")


class OcrProvider(StrEnum):
    # Free and local (PP-OCR models on ONNX Runtime), the default.
    RAPIDOCR = "rapidocr"
    # A vision model behind an OpenAI-compatible API (a local Ollama, or an external one).
    VISION = "vision"


@dataclass(frozen=True)
class OcrConfig:
    provider: OcrProvider
    limits: OcrLimits
    base_timeout_s: float
    seconds_per_page: float


class VisionCache:
    """Answers kept per user and per image, model and prompt, so a retry never pays twice."""

    def __init__(self, blobs: BlobStore) -> None:
        self._blobs = blobs

    async def read(self, vision: VisionClient, user_id: str, prompt: str, uri: str) -> str:
        key = f"{user_id}/vision-cache/{vision.cache_key(prompt, uri)}.md"
        cached = await self._blobs.get_if_present(key)
        if cached is not None:
            return cached.decode()
        text = await vision.read(prompt, uri)
        if text:
            await self._blobs.put_bytes(key, text.encode(), "text/markdown")
        return text


class OcrRunner:
    def __init__(
        self,
        pool: ParsePool,
        contents: ContentStore,
        config: OcrConfig,
        now: Callable[[], datetime],
        vision: VisionClient | None = None,
        cache: VisionCache | None = None,
    ) -> None:
        self._pool, self._contents, self._config, self._now = pool, contents, config, now
        self._vision, self._cache = vision, cache

    async def _record(self, content: Content, provider: "OcrProvider") -> None:
        # Saved, so retries of this revision read it the same way.
        await self._contents.update(content.id, self._now(), ocr_provider=provider.value)

    def _timeout(self, content: Content) -> float:
        pages = int((content.facts or {}).get("pages") or 1)
        return self._config.base_timeout_s + pages * self._config.seconds_per_page

    async def parse(self, content: Content, data: bytes) -> ParseResult:
        provider = OcrProvider(content.ocr_provider or self._config.provider)
        if provider == OcrProvider.VISION and self._vision is None:
            logger.warning(
                "no vision model configured; using rapidocr", extra={"contentId": content.id}
            )
            provider = OcrProvider.RAPIDOCR
        if provider == OcrProvider.VISION:
            await self._record(content, provider)
            try:
                return await self._with_vision(content, data)
            except (VisionUnavailableError, VisionTruncatedError) as err:
                logger.warning(
                    "vision ocr failed; using rapidocr",
                    extra={"contentId": content.id, "why": str(err)},
                )
                provider = OcrProvider.RAPIDOCR
        await self._record(content, provider)
        reader = parse_scanned_pdf if content.mime_type == PDF else parse_image
        result: ParseResult = await self._pool.run(
            reader,
            data,
            content.mime_type,
            self._config.limits,
            label=f"ocr {content.id}",
            timeout_s=self._timeout(content),
        )
        return result

    async def _with_vision(self, content: Content, data: bytes) -> ParseResult:
        assert self._vision is not None and self._cache is not None
        vision, cache = self._vision, self._cache
        pages = await self._pool.run(
            render_pages,
            data,
            content.mime_type,
            self._config.limits,
            label=f"render {content.id}",
            timeout_s=self._timeout(content),
        )
        texts = await asyncio.gather(
            *(cache.read(vision, content.user_id, OCR_PROMPT, page.uri) for page in pages)
        )
        return ParseResult(
            pages_to_blocks([(p.number, t) for p, t in zip(pages, texts, strict=True)])
        )
