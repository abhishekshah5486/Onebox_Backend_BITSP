"""Sentences and windows for indexing: rule-based sentence splitting in the record's language,
and overlapping windows for text too long to embed whole."""

import re
import threading
from functools import lru_cache

import pysbd
import pysbd.languages
from lingua import Language, LanguageDetectorBuilder

# pysbd's time grows with the square of the text; longer text is split at punctuation.
MAX_SEGMENTED_CHARS = 50_000
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
LANGUAGE_SAMPLE_CHARS = 2000
PYSBD_LANGUAGES = frozenset(pysbd.languages.LANGUAGE_CODES)
_segmenters = threading.local()


@lru_cache(maxsize=1)
def _detector():  # type: ignore[no-untyped-def]
    # Only the languages pysbd can split: anything else is split as English anyway.
    languages = [
        lang for lang in Language.all() if lang.iso_code_639_1.name.lower() in PYSBD_LANGUAGES
    ]
    return LanguageDetectorBuilder.from_languages(*languages).with_low_accuracy_mode().build()


def detect_language(texts: list[str]) -> str:
    """The ISO 639-1 code of a record's language, from a sample of its text; "en" if unsure."""
    sample, size = [], 0
    for text in texts:
        if text.strip():
            sample.append(text)
            size += len(text)
        if size >= LANGUAGE_SAMPLE_CHARS:
            break
    if not sample:
        return "en"
    found = _detector().detect_language_of(" ".join(sample)[: LANGUAGE_SAMPLE_CHARS * 2])
    code = found.iso_code_639_1.name.lower() if found is not None else "en"
    return code if code in PYSBD_LANGUAGES else "en"


def _segmenter(language: str) -> pysbd.Segmenter:
    cache: dict[str, pysbd.Segmenter] = getattr(_segmenters, "by_language", {})
    _segmenters.by_language = cache
    if language not in cache:
        cache[language] = pysbd.Segmenter(language=language, clean=False)
    return cache[language]


def split_sentences(text: str, language: str = "en") -> list[str]:
    if not text.strip():
        return []
    if len(text) <= MAX_SEGMENTED_CHARS:
        try:
            return [s.strip() for s in _segmenter(language).segment(text) if s.strip()]
        except Exception:  # noqa: S110 - the punctuation split below is the fallback
            pass
    return [s.strip() for s in SENTENCE_END.split(text) if s.strip()]


def windows(text: str, language: str, size: int, overlap: int) -> list[str]:
    """Sentences packed into windows of about `size` characters, each starting with the last
    `overlap` characters' worth of sentences of the one before; a sentence longer than a
    window is cut between words."""
    pieces = [p for s in split_sentences(text, language) for p in _cut(s, size)]
    out: list[str] = []
    current: list[str] = []
    length = 0
    for piece in pieces:
        if current and length + len(piece) + 1 > size:
            out.append(" ".join(current))
            kept: list[str] = []
            kept_length = 0
            for previous in reversed(current):
                if kept_length + len(previous) > overlap:
                    break
                kept.insert(0, previous)
                kept_length += len(previous) + 1
            current, length = kept, kept_length
        current.append(piece)
        length += len(piece) + 1
    if current:
        out.append(" ".join(current))
    return out or [text]


def _cut(text: str, size: int) -> list[str]:
    out = []
    while len(text) > size:
        space = text.rfind(" ", 0, size + 1)
        cut = space if space > 0 else size
        out.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        out.append(text)
    return out
