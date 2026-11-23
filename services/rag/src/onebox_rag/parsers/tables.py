from typing import Any

from onebox_rag.models.blocks import (
    BlockGroup,
    BlockType,
    DataFormat,
    GroupType,
    TableMetadata,
    TableRowMetadata,
)
from onebox_rag.parsers.builder import BlocksBuilder


def row_text(columns: list[str], cells: list[str]) -> str:
    """A row as "column: value" pairs, the plain form PipesHub uses before any LLM rewrite."""
    pairs = []
    for i, cell in enumerate(cells):
        value = cell.strip()
        if not value:
            continue
        column = columns[i].strip() if i < len(columns) and columns[i].strip() else ""
        pairs.append(f"{column}: {value}" if column else value)
    return ", ".join(pairs)


def add_table(
    out: BlocksBuilder,
    header: list[str],
    rows: list[list[str]],
    *,
    parent: BlockGroup | None = None,
    name: str | None = None,
    first_line: int | None = None,
    row_lines: list[int] | None = None,
    format: DataFormat = DataFormat.TXT,
    **citation: Any,
) -> BlockGroup:
    """A TABLE group with one TABLE_ROW block per data row."""
    width = max([len(header), *(len(r) for r in rows)], default=0)
    table = out.group(
        GroupType.TABLE,
        parent=parent,
        name=name,
        format=format,
        citation_metadata=out.citation(line_number=first_line, **citation),
        table_metadata=TableMetadata(
            num_of_rows=len(rows),
            num_of_cols=width,
            has_header=bool(header),
            column_names=header or None,
        ),
    )
    for number, cells in enumerate(rows, start=1):
        text = row_text(header, cells)
        if not text:
            continue
        out.block(
            BlockType.TABLE_ROW,
            {"text": text, "cells": cells},
            parent=table,
            format=format,
            table_row_metadata=TableRowMetadata(row_number=number),
            citation_metadata=out.citation(
                row_number=number,
                line_number=row_lines[number - 1] if row_lines else None,
                **citation,
            ),
        )
    return table
