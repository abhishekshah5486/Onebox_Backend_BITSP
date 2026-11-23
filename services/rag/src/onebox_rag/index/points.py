"""What gets embedded from a record's blocks: a point per block (paragraph, heading, list
item, table row sentence, image description), one per table for its summary, and sentence
points for long blocks; a block too long to embed whole becomes overlapping windows. A
table's rows and summary are led by its title."""

import uuid
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from onebox_rag.index.split import detect_language, split_sentences, windows
from onebox_rag.index.texts import embed_text, table_titles, with_title, without_urls
from onebox_rag.models.blocks import Block, BlocksContainer, BlockType, GroupType

POINT_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "onebox:rag-point")


class PointKind(StrEnum):
    BLOCK = "block"  # a whole block
    SENTENCE = "sentence"  # one sentence of a long block, for precise matches
    WINDOW = "window"  # part of a block too long to embed whole
    TABLE = "table"  # a table's summary and columns


@dataclass(frozen=True)
class PointText:
    text: str
    kind: PointKind
    block_index: int | None  # the block, or None for a table point
    group_index: int | None  # the table a row or summary belongs to
    payload: dict[str, Any]

    def point_id(self, content_id: str, revision: int) -> str:
        """Stable for the same text of the same block, so a retry overwrites, never duplicates."""
        where = self.block_index if self.block_index is not None else f"g{self.group_index}"
        name = f"{content_id}|{revision}|{where}|{self.kind}|{self.text}"
        return str(uuid.uuid5(POINT_NAMESPACE, name))


@dataclass(frozen=True)
class SplitSettings:
    # Longer blocks are embedded as windows instead (embedding models cap their input).
    max_block_chars: int = 8000
    window_chars: int = 1500
    window_overlap: int = 200
    # Blocks with more words also get a point per sentence.
    sentence_min_words: int = 100


def point_texts(container: BlocksContainer, settings: SplitSettings) -> list[PointText]:
    texts = [b.text() for b in container.blocks if b.type == BlockType.TEXT]
    language = detect_language(texts)
    titles = table_titles(container.blocks, container.block_groups)
    points: list[PointText] = []
    for block in container.blocks:
        if _skipped(block):
            continue
        text = embed_text(block).strip()
        if not text:
            continue
        payload = citation_of(block)
        table = block.parent_index if block.type == BlockType.TABLE_ROW else None
        if table is not None:
            text = with_title(titles.get(table), text)
        if len(text) > settings.max_block_chars:
            points += [
                PointText(piece, PointKind.WINDOW, block.index, table, payload)
                for piece in windows(text, language, settings.window_chars, settings.window_overlap)
            ]
            continue
        points.append(PointText(text, PointKind.BLOCK, block.index, table, payload))
        if block.type == BlockType.TEXT and len(text.split()) > settings.sentence_min_words:
            sentences = split_sentences(text, language)
            if len(sentences) > 1:
                points += [
                    PointText(s, PointKind.SENTENCE, block.index, table, payload) for s in sentences
                ]
    for group in container.block_groups:
        if group.type != GroupType.TABLE:
            continue
        summary = group.semantic_metadata.summary if group.semantic_metadata else None
        columns = group.table_metadata.column_names if group.table_metadata else None
        body = embed_text_of(summary) or (f"Columns: {', '.join(columns)}" if columns else "")
        text = with_title(titles.get(group.index), body) if body else ""
        if text:
            cite = group.citation_metadata
            payload = {"page": cite.page_number, "sheet": cite.sheet_name} if cite else {}
            points.append(
                PointText(
                    text[: settings.max_block_chars],
                    PointKind.TABLE,
                    None,
                    group.index,
                    {k: v for k, v in payload.items() if v is not None},
                )
            )
    return points


def embed_text_of(text: str | None) -> str:
    return without_urls(text or "").strip()


def _skipped(block: Block) -> bool:
    if block.type == BlockType.TABLE_ROW:
        # Header rows are the table's column names, carried by its table point.
        return bool(block.table_row_metadata and block.table_row_metadata.is_header)
    return False


def citation_of(block: Block) -> dict[str, Any]:
    """Where the block is, kept on its points so a hit can be cited without reading blocks."""
    cite = block.citation_metadata
    if cite is None:
        return {}
    fields = {
        "page": cite.page_number,
        "sheet": cite.sheet_name,
        "row": cite.row_number,
        "slide": cite.slide_number,
        "line": cite.line_number,
        "headingPath": cite.heading_path or None,
    }
    return {k: v for k, v in fields.items() if v is not None}
