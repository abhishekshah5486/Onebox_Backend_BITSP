"""How much text one embedding input may hold, counted in tokens, and cutting what is longer
into pieces that each fit, so a model never silently drops the end of a passage or rejects
the record."""

import codecs
import logging
import math
from dataclasses import dataclass
from functools import cache
from typing import Any

import tiktoken

logger = logging.getLogger("onebox_rag.index")

# Begin and end markers some models add around every input.
_MARKERS = 2
_MAX_SPLIT_ATTEMPTS = 16
# Fewest tokens of text an input must have room for to make a useful point.
MIN_TEXT_TOKENS = 16


class TokenLimitError(ValueError):
    """The embedding model reads too few tokens per input to index anything useful."""


@cache
def _encoder() -> Any:
    """cl100k (OpenAI's embedding tokenizer), or None when its vocabulary can't be loaded:
    then a byte stands for a token, which no tokenizer goes over."""
    try:
        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        logger.warning("cl100k unavailable, counting bytes as tokens", exc_info=True)
        return None


@dataclass(frozen=True)
class TokenWindow:
    # Tokens one input may hold.
    limit: int
    # A cl100k count times this bounds the model's own count (1 for OpenAI's models).
    ratio: float = 1.0

    def __post_init__(self) -> None:
        if self.limit - _MARKERS < MIN_TEXT_TOKENS:
            raise TokenLimitError(
                f"The embedding model reads only {self.limit} tokens per input; at least "
                f"{MIN_TEXT_TOKENS + _MARKERS} are needed. Choose a model with a longer input."
            )

    def count(self, text: str) -> int:
        encoder = _encoder()
        if encoder is None:
            return len(text.encode("utf-8")) + _MARKERS
        tokens = len(encoder.encode(text, disallowed_special=()))
        return math.ceil(tokens * self.ratio) + _MARKERS

    def fits(self, text: str) -> bool:
        # Every token covers at least one byte, so short text never needs counting.
        if len(text.encode("utf-8")) + _MARKERS <= self.limit:
            return True
        return self.count(text) <= self.limit

    def split(self, text: str) -> list[str]:
        """`text` whole when it fits, else pieces that each do, joining back to it. Each try
        is measured, and the step halved until every piece fits: a cut can make a piece
        count a little more than the tokens it was cut from."""
        if self.fits(text):
            return [text]
        step = max(1, math.floor((self.limit - _MARKERS) / self.ratio))
        pieces = [text]
        for _ in range(_MAX_SPLIT_ATTEMPTS):
            pieces = _slice(text, step)
            if all(self.fits(piece) for piece in pieces):
                return pieces
            step = max(1, step // 2)
        logger.warning(
            "text not cut under the token limit",
            extra={"characters": len(text), "limit": self.limit, "pieces": len(pieces)},
        )
        return pieces


def _slice(text: str, step: int) -> list[str]:
    """Pieces of at most `step` tokens (or bytes), cut on character boundaries: a cut may
    fall inside a character, so its bytes are carried into the next piece."""
    raw = text.encode("utf-8")
    encoder = _encoder()
    if encoder is None:
        chunks = [raw[i : i + step] for i in range(0, len(raw), step)]
    else:
        tokens = encoder.encode(text, disallowed_special=())
        chunks = [encoder.decode_bytes(tokens[i : i + step]) for i in range(0, len(tokens), step)]
    decoder = codecs.getincrementaldecoder("utf-8")()
    pieces = [piece for chunk in chunks if (piece := decoder.decode(chunk))]
    tail = decoder.decode(b"", final=True)
    if tail:
        pieces.append(tail)
    return pieces
