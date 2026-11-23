"""Tables in a grid of cells (a CSV file or a worksheet): each is a rectangle of cells bounded by
empty rows and columns. Every row becomes a block, header rows flagged, so table enrichment can
decide the header again without moving blocks."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from onebox_rag.models.blocks import (
    BlockGroup,
    BlockType,
    DataFormat,
    GroupType,
    TableMetadata,
    TableRowMetadata,
)
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.tables import looks_like_header, row_text

# Rows indexed per table; the rest of a huge table is left out.
MAX_TABLE_ROWS = 20_000
# A lone value above a table this wide is its title.
MIN_TITLED_WIDTH = 3


@dataclass(frozen=True)
class GridTable:
    top: int  # 0-based row and column of its top-left cell
    left: int
    rows: list[list[str]]


def find_tables(grid: list[list[str]]) -> list[GridTable]:
    """Grows a rectangle from each unclaimed filled cell (row by row) until no filled cell
    touches its edges; cells in it are claimed, so tables never overlap."""
    width = max((len(row) for row in grid), default=0)
    if not grid or not width:
        return []
    filled = np.zeros((len(grid), width), dtype=bool)
    for r, row in enumerate(grid):
        for c, cell in enumerate(row):
            filled[r, c] = bool(cell.strip())
    claimed = np.zeros_like(filled)
    tables = []
    for r, c in np.argwhere(filled):
        if claimed[r, c]:
            continue
        top, left, bottom, right = _grow(filled, int(r), int(c))
        claimed[top : bottom + 1, left : right + 1] = True
        rows = [
            [(grid[i][j].strip() if j < len(grid[i]) else "") for j in range(left, right + 1)]
            for i in range(top, bottom + 1)
        ]
        tables.append(GridTable(top, left, rows))
    return tables


def _grow(filled: np.ndarray, row: int, col: int) -> tuple[int, int, int, int]:
    height, width = filled.shape
    top, left, bottom, right = row, col, row, col
    grew = True
    while grew:
        grew = False
        while right + 1 < width and filled[top : bottom + 1, right + 1].any():
            right, grew = right + 1, True
        while left > 0 and filled[top : bottom + 1, left - 1].any():
            left, grew = left - 1, True
        while bottom + 1 < height and filled[bottom + 1, left : right + 1].any():
            bottom, grew = bottom + 1, True
        while top > 0 and filled[top - 1, left : right + 1].any():
            top, grew = top - 1, True
    return top, left, bottom, right


def guess_header_rows(rows: list[list[str]]) -> int:
    """1 when the first row reads as labels over data, else 0; the LLM decides for real later."""
    return 1 if len(rows) > 1 and looks_like_header(rows[0]) else 0


def leading_lines(table: GridTable) -> int:
    """Rows at the top that are titles or notes, not table rows: one value (a merged title
    repeats it) over a table at least MIN_TITLED_WIDTH wide, or the only row there is."""
    width = len(table.rows[0])
    count = 0
    for cells in table.rows:
        lone = len(table.rows) - count == 1
        if not (lone or (width >= MIN_TITLED_WIDTH and len({c for c in cells if c}) == 1)):
            break
        count += 1
    return count


def add_sheet_table(
    out: BlocksBuilder,
    table: GridTable,
    *,
    guess_header: Callable[[list[list[str]]], int] = guess_header_rows,
    parent: BlockGroup | None = None,
    format: DataFormat = DataFormat.CSV,
    cite: Callable[[int, int], dict[str, Any]] | None = None,
) -> BlockGroup | None:
    """Leading titles as text, then a table of every row. `cite(i, width)` gives the citation
    fields of the table's i-th row; by default its row number in the file."""
    where = cite or (lambda i, _width: {"row_number": table.top + i + 1})
    width = len(table.rows[0])
    start = leading_lines(table)
    for i in range(start):
        line = " ".join(dict.fromkeys(cell for cell in table.rows[i] if cell))
        out.text(line, parent=parent, citation_metadata=out.citation(**where(i, width)))
    rows = table.rows[start:]
    if not rows:
        return None
    header_rows = guess_header(rows)
    rows = rows[: MAX_TABLE_ROWS + header_rows]
    header = rows[0] if header_rows else []
    group = out.group(
        GroupType.TABLE,
        parent=parent,
        format=format,
        citation_metadata=out.citation(**where(start, width)),
        table_metadata=TableMetadata(
            num_of_rows=len(rows) - header_rows,
            num_of_cols=width,
            has_header=bool(header_rows),
            column_names=header or None,
            header_guessed=True,
        ),
    )
    for offset, cells in enumerate(rows):
        is_header = offset < header_rows
        text = " | ".join(c for c in cells if c) if is_header else row_text(header, cells)
        if not text:
            continue
        fields = where(start + offset, width)
        out.block(
            BlockType.TABLE_ROW,
            {"text": text, "cells": cells},
            parent=group,
            format=format,
            table_row_metadata=TableRowMetadata(
                row_number=fields.get("row_number"), is_header=is_header
            ),
            citation_metadata=out.citation(**fields),
        )
    return group
