"""Descriptions for pictures, written by the vision model onto their image blocks (any text in a
picture is transcribed too, so a screenshot or a scanned insert becomes searchable)."""

import asyncio
import base64
import io
import logging

from PIL import Image

from onebox_rag.models.blocks import BlocksContainer, BlockType, ImageMetadata
from onebox_rag.pipeline.ocr import VisionCache
from onebox_rag.pipeline.prompts import DESCRIBE_PROMPT
from onebox_rag.pipeline.vision import VisionClient

logger = logging.getLogger("onebox_rag.describe")

MAX_DESCRIPTION_CHARS = 8_000
# Pictures are scaled to fit model limits before a call.
MAX_LONG_EDGE_PX = 2000
MAX_IMAGE_BYTES = 5 * 2**20
# Bullets, icons, spacers, avatars and rules aren't worth a model call.
MIN_SHORT_EDGE_PX = 64
MIN_AREA_PX = 10_000
MAX_ASPECT_RATIO = 10.0


def is_decorative(uri: str) -> bool:
    try:
        with Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))) as image:
            width, height = image.size
    except Exception:
        return True
    short, long = sorted((width, height))
    return (
        short < MIN_SHORT_EDGE_PX or width * height < MIN_AREA_PX or long / short > MAX_ASPECT_RATIO
    )


def fit_for_model(uri: str) -> str:
    """The picture re-encoded within the model's size limits, or as it was when it fits."""
    raw = base64.b64decode(uri.split(",", 1)[1])
    with Image.open(io.BytesIO(raw)) as image:
        if max(image.size) <= MAX_LONG_EDGE_PX and len(raw) <= MAX_IMAGE_BYTES:
            return uri
        rgb = image.convert("RGB")
        rgb.thumbnail((MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX))
        out = io.BytesIO()
        rgb.save(out, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()


class ImageDescriber:
    def __init__(self, vision: VisionClient, cache: VisionCache, max_images: int) -> None:
        self._vision, self._cache, self._max = vision, cache, max_images

    async def describe(self, user_id: str, container: BlocksContainer) -> int:
        """Describes up to `max_images` pictures; one that fails is skipped, never the record."""
        pending = [
            block
            for block in container.blocks
            if block.type == BlockType.IMAGE
            and isinstance(block.data, str)
            and block.data.startswith("data:image/")
            and not (block.image_metadata and block.image_metadata.description)
            and not is_decorative(block.data)
        ][: self._max]

        async def one(block_index: int) -> bool:
            block = container.blocks[block_index]
            try:
                uri = fit_for_model(block.data)
                text = await self._cache.read(self._vision, user_id, DESCRIBE_PROMPT, uri)
            except Exception as err:
                logger.warning("image description failed", extra={"why": str(err)[:200]})
                return False
            if not text:
                return False
            if block.image_metadata is None:
                block.image_metadata = ImageMetadata()
            block.image_metadata.description = text[:MAX_DESCRIPTION_CHARS]
            return True

        done = await asyncio.gather(*(one(block.index) for block in pending))
        return sum(done)
