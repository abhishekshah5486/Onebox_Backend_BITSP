"""A record's blocks in order, a page at a time, for a reader that needs all of it (a whole
document, or every row of a table to compute over)."""

from typing import Any

from onebox_rag.index.points import citation_of
from onebox_rag.index.texts import image_text
from onebox_rag.models.blocks import BlocksContainer, BlockType


def read_page(container: BlocksContainer, start: int, max_blocks: int) -> dict[str, Any]:
    total = len(container.blocks)
    page = container.blocks[start : start + max_blocks]
    blocks = []
    groups: set[int] = set()
    for block in page:
        text = image_text(block) if block.type == BlockType.IMAGE else block.text()
        if not text.strip():
            continue
        entry: dict[str, Any] = {"index": block.index, "type": block.type, "text": text}
        if block.table_row_metadata and block.table_row_metadata.is_header:
            entry["isHeader"] = True
        if block.parent_index is not None:
            entry["groupIndex"] = block.parent_index
            groups.add(block.parent_index)
        cite = citation_of(block)
        if cite:
            entry["citation"] = cite
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
