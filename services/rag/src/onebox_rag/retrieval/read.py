"""A record's blocks in order, a page at a time, for a reader that needs all of it (a whole
document, or every row of a table to compute over); or, for a record too long to read whole,
the part that answers a question."""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from onebox_rag.index.points import citation_of
from onebox_rag.index.texts import image_text
from onebox_rag.models.blocks import Block, BlocksContainer, BlockType


def read_page(container: BlocksContainer, start: int, max_blocks: int) -> dict[str, Any]:
    total = len(container.blocks)
    page = container.blocks[start : start + max_blocks]
    blocks = []
    groups: set[int] = set()
    for block in page:
        entry = _entry(block)
        if entry is None:
            continue
        if block.parent_index is not None:
            groups.add(block.parent_index)
        blocks.append(entry)
    end = start + len(page)
    return {
        "blocks": blocks,
        "groups": [_group(container, i) for i in sorted(groups)],
        "start": start,
        "total": total,
        # Where to continue, or None once the record is read.
        "next": end if end < total else None,
    }


@dataclass(frozen=True)
class FocusSettings:
    # Characters a focused read returns; a record that fits is returned whole.
    max_chars: int = 16_000
    # The record's opening comes whatever the ranking says, up to this share and size.
    opening_share: float = 0.15
    opening_max_chars: int = 8_000
    # Blocks either side of a match that come with it.
    neighbour_span: int = 1


# What each block costs beyond its text (its label).
_BLOCK_OVERHEAD = 12
# What a gap marker costs the reader.
_GAP_CHARS = 160


def focused_read(
    container: BlocksContainer, matches: Sequence[int], settings: FocusSettings
) -> dict[str, Any] | None:
    """The record whole when it fits; else its opening, then each match (best first) with its
    neighbours, admitted whole or not at all, then grown outward to fill the room, in record
    order with the gaps named so the reader knows the record isn't all there. None when
    no match fits (read it in order instead)."""
    entries = {b.index: e for b in container.blocks if (e := _entry(b)) is not None}
    available = sorted(entries)
    cost = {i: len(entries[i]["text"]) + _BLOCK_OVERHEAD for i in available}
    room = settings.max_chars
    if sum(cost.values()) <= room:
        return _render(container, entries, available, set(available))
    selected: set[int] = set()
    spent = 0
    opening = min(int(room * settings.opening_share), settings.opening_max_chars)
    for index in available:  # contiguous: stops at the first block that doesn't fit
        if spent + cost[index] > opening:
            break
        selected.add(index)
        spent += cost[index]
    known = set(available)
    hits = [i for i in dict.fromkeys(matches) if i in known]
    for hit in hits:
        span = settings.neighbour_span
        fresh = [i for i in range(hit - span, hit + span + 1) if i in known and i not in selected]
        if not fresh:
            continue
        extra = sum(cost[i] for i in fresh)
        if not any(i - 1 in selected or i + 1 in selected for i in fresh):
            extra += _GAP_CHARS
        if spent + extra > room:
            break
        selected.update(fresh)
        spent += extra
    if not selected.intersection(hits):
        return None
    # Relevance decides what comes first, not how much: the rest of the room widens what
    # was chosen, a block at a time either side.
    grew = True
    while grew and spent < room:
        grew = False
        for index in available:
            if index in selected or not (index - 1 in selected or index + 1 in selected):
                continue
            if spent + cost[index] <= room:
                selected.add(index)
                spent += cost[index]
                grew = True
    return _render(container, entries, available, selected)


def _render(
    container: BlocksContainer,
    entries: dict[int, dict[str, Any]],
    available: list[int],
    selected: set[int],
) -> dict[str, Any]:
    shown = [i for i in available if i in selected]
    gaps, previous = [], available[0] - 1 if available else -1
    for index in shown:
        if index > previous + 1:
            gaps.append({"from": previous + 1, "to": index - 1})
        previous = index
    groups = sorted({g for i in shown if (g := container.blocks[i].parent_index) is not None})
    return {
        "blocks": [entries[i] for i in shown],
        "groups": [_group(container, g) for g in groups],
        "start": 0,
        "total": len(container.blocks),
        "next": None,
        # Ranges not shown; read them in order (`start`) or with another question.
        "gaps": gaps,
    }


def _entry(block: Block) -> dict[str, Any] | None:
    text = image_text(block) if block.type == BlockType.IMAGE else block.text()
    if not text.strip():
        return None
    entry: dict[str, Any] = {"index": block.index, "type": block.type, "text": text}
    if block.table_row_metadata and block.table_row_metadata.is_header:
        entry["isHeader"] = True
    if block.parent_index is not None:
        entry["groupIndex"] = block.parent_index
    cite = citation_of(block)
    if cite:
        entry["citation"] = cite
    return entry


def _group(container: BlocksContainer, index: int) -> dict[str, Any]:
    group = container.block_groups[index]
    out: dict[str, Any] = {"index": index, "type": group.type}
    if group.name:
        out["name"] = group.name
    if group.semantic_metadata and group.semantic_metadata.summary:
        out["summary"] = group.semantic_metadata.summary
    meta = group.table_metadata
    if meta is not None:
        out |= {"rows": meta.num_of_rows, "columns": meta.column_names}
    return out
