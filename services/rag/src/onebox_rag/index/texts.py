"""The text a point embeds, where it differs from the stored block: URLs cut to their host,
images with their alt text, and table rows led by their table's title."""

import re
from collections.abc import Sequence
from urllib.parse import urlsplit

from onebox_rag.models.blocks import Block, BlockGroup, BlockType

# A link target means nothing to a dense model and repeats its words in BM25; the host is
# the part people search for. Code keeps its URLs.
_URL = re.compile(r"<?(?<![\w/@.])(?:https?|ftp)://[^\s<>\"'`\[\]]+>?", re.IGNORECASE)
_TRAILING = ".,;:!?'\")"
_SPACES = re.compile(r"[ \t]{2,}")

# A table's title is up to this many short text lines right above its first row.
TITLE_LINES = 2
TITLE_MAX_CHARS = 150
TITLE_LOOKBACK = 6
_PAGE_NUMBER = re.compile(r"^(?:page\s+)?\d{1,4}$", re.IGNORECASE)


def without_urls(text: str) -> str:
    if "://" not in text:
        return text

    def host(match: re.Match[str]) -> str:
        url = match.group(0).strip("<>")
        tail = ""
        while url and url[-1] in _TRAILING and not (url[-1] == ")" and "(" in url):
            url, tail = url[:-1], url[-1] + tail
        return (urlsplit(url).hostname or "") + tail

    return _SPACES.sub(" ", _URL.sub(host, text)).strip()


def embed_text(block: Block) -> str:
    if block.type == BlockType.IMAGE:
        return image_text(block)
    text = block.text()
    return text if block.type == BlockType.CODE else without_urls(text)


def image_text(block: Block) -> str:
    """The description, else captions; plus the author's alt text, which names what a
    description can only depict ("Revenue FY26" against "a bar chart")."""
    meta = block.image_metadata
    if meta is None:
        return ""
    alt = (meta.alt_text or "").strip()
    described = (meta.description or "").strip()
    if described:
        return f"{described} {alt}" if alt and alt.lower() not in described.lower() else described
    parts = [c for c in meta.captions if c]
    if alt and alt not in parts:
        parts.append(alt)
    return " ".join(parts).strip()


def table_titles(blocks: Sequence[Block], groups: Sequence[BlockGroup]) -> dict[int, str]:
    """Table index -> its title, put before each of its rows: a row sentence never names the
    statement or sheet it belongs to, so "balance sheet current assets" would match nothing.
    The title is the short lines right above the table in the same place (page, or sheet:
    a sheet's name leads its titles)."""
    first_row: dict[int, int] = {}
    for position, block in enumerate(blocks):
        if block.type == BlockType.TABLE_ROW and block.parent_index is not None:
            first_row.setdefault(block.parent_index, position)
    titles: dict[int, str] = {}
    for group in groups:
        start = first_row.get(group.index)
        cite = group.citation_metadata
        if start is None or cite is None:
            continue
        lines: list[str] = []
        place = (cite.page_number, cite.sheet_name)
        if place != (None, None):
            for block in reversed(blocks[max(0, start - TITLE_LOOKBACK) : start]):
                text = block.text().strip()
                where = block.citation_metadata
                same_place = where is not None and (where.page_number, where.sheet_name) == place
                if block.type != BlockType.TEXT or not same_place or not text:
                    break
                if len(text) > TITLE_MAX_CHARS:
                    break
                if not _PAGE_NUMBER.match(text):
                    lines.insert(0, " ".join(text.split()))
                if len(lines) >= TITLE_LINES:
                    break
        title = " ".join(lines)
        if cite.sheet_name and cite.sheet_name != title:
            title = f"{cite.sheet_name} - {title}" if title else cite.sheet_name
        if title:
            titles[group.index] = title
    return titles


def with_title(title: str | None, text: str) -> str:
    return f"{title}: {text}" if title else text
