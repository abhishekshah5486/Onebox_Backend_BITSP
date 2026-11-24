"""Table enrichment: the model decides a spreadsheet's header rows (or names its columns),
summarizes each table and rewrites its rows as sentences. Anything it can't do keeps plain
"column: value" text, so a table is never lost to a failed call."""

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Any

from onebox_rag.models.blocks import (
    Block,
    BlockGroup,
    BlocksContainer,
    GroupType,
    SemanticMetadata,
    TableMetadata,
)
from onebox_rag.parsers.tables import row_text
from onebox_rag.pipeline.llm import LlmClient, LlmUnavailableError, OutOfCreditsError
from onebox_rag.pipeline.prompts import (
    KNOWN_HEADERS_CONTEXT,
    NO_HEADERS_CONTEXT,
    ROW_TEXT_PROMPT,
    ROW_TEXT_SYSTEM,
    TABLE_ANALYSIS_PROMPT,
    TABLE_ANALYSIS_SYSTEM,
)

logger = logging.getLogger("onebox_rag.tables")

# Rows shown for header detection and the summary; more header rows than this aren't believed.
ANALYSIS_ROWS = 10
MAX_HEADER_ROWS = 3
# Cells are cut to this in prompts, so one huge cell can't crowd out the rest.
PROMPT_CELL_CHARS = 500
# A batch that comes back missing more than this share of its rows is split and asked again.
ROW_MISS_TOLERANCE = 0.1
MIN_SPLIT_ROWS = 5
KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"  # no 0/1/8/9 to mistake for O/I/B/g
KEY_CHARS = 4

ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "has_headers": {"type": "boolean"},
        "num_header_rows": {"type": "integer", "minimum": 0},
        "headers": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["has_headers", "num_header_rows", "headers", "summary"],
    "additionalProperties": False,
}
ROWS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "descriptions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"key": {"type": "string"}, "description": {"type": "string"}},
                "required": ["key", "description"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["descriptions"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class TableSettings:
    # Rows per file described by the model, in document order; the rest stay "column: value".
    max_llm_rows: int
    batch_rows: int
    concurrency: int
    max_output_tokens: int


@dataclass
class _Table:
    group: BlockGroup
    rows: list[Block]  # every row block, header rows first

    def cells(self, block: Block) -> list[str]:
        return [str(c) for c in (block.data or {}).get("cells") or []]


class TableEnricher:
    def __init__(self, llm: LlmClient, settings: TableSettings) -> None:
        self._llm, self._settings = llm, settings

    async def enrich(self, user_id: str, container: BlocksContainer) -> int:
        """Enriches the container's tables in place; returns how many rows got sentences."""
        tables = _tables(container)
        if not tables:
            return 0
        slots = asyncio.Semaphore(self._settings.concurrency)
        budget = [self._settings.max_llm_rows]
        described = 0
        try:
            for table in tables:
                described += await self._table(user_id, table, slots, budget)
        except OutOfCreditsError:
            logger.info("out of AI credits; the remaining tables keep plain rows")
        return described

    async def _table(
        self, user_id: str, table: _Table, slots: asyncio.Semaphore, budget: list[int]
    ) -> int:
        meta = table.group.table_metadata or TableMetadata()
        grid = [table.cells(b) for b in table.rows]
        width = max((len(r) for r in grid), default=0)
        if not width:
            return 0
        guessed = meta.header_guessed
        if guessed:
            # Every row is a block: the model decides which are headers.
            sample, context = grid[:ANALYSIS_ROWS], ""
        elif meta.has_header and meta.column_names:
            sample = grid[:ANALYSIS_ROWS]
            context = KNOWN_HEADERS_CONTEXT.format(
                headers=json.dumps(meta.column_names, ensure_ascii=False)
            )
        else:
            sample, context = grid[:ANALYSIS_ROWS], NO_HEADERS_CONTEXT
        try:
            async with slots:
                analysis = await self._llm.json(
                    user_id,
                    [
                        {"role": "system", "content": TABLE_ANALYSIS_SYSTEM},
                        {
                            "role": "user",
                            "content": TABLE_ANALYSIS_PROMPT.format(
                                rows_text=_numbered(sample),
                                column_count=width,
                                header_context=context,
                            ),
                        },
                    ],
                    "table_analysis",
                    ANALYSIS_SCHEMA,
                    max_output_tokens=self._settings.max_output_tokens,
                )
        except OutOfCreditsError:
            raise
        except LlmUnavailableError as err:
            logger.warning("table analysis failed; plain rows", extra={"why": str(err)})
            return 0

        header_rows = 0
        if guessed and analysis.get("has_headers"):
            header_rows = min(int(analysis.get("num_header_rows") or 0), MAX_HEADER_ROWS)
            header_rows = min(header_rows, len(grid) - 1)
        if guessed:
            headers = _headers(grid[:header_rows], analysis.get("headers") or [], width)
        elif meta.has_header and meta.column_names:
            headers = list(meta.column_names)
        else:
            headers = _headers([], analysis.get("headers") or [], width)
        summary = str(analysis.get("summary") or "").strip() or _plain_summary(
            headers, len(grid) - header_rows
        )

        data = table.rows[header_rows:] if guessed else table.rows
        for i, block in enumerate(table.rows):
            if block.table_row_metadata is not None and guessed:
                block.table_row_metadata.is_header = i < header_rows
            cells = table.cells(block)
            if guessed and i < header_rows:
                block.data = {"text": " | ".join(c for c in cells if c), "cells": cells}
            else:
                block.data = {"text": row_text(headers, cells), "cells": cells}
        table.group.table_metadata = meta.model_copy(
            update={
                "column_names": headers,
                "has_header": bool(header_rows) or bool(meta.has_header and not guessed),
                "header_guessed": False,
                "num_of_rows": len(data),
            }
        )
        table.group.semantic_metadata = SemanticMetadata(summary=summary)

        allowed = max(0, min(len(data), budget[0]))
        budget[0] -= allowed
        if not allowed:
            return 0
        rows = [dict(zip(headers, table.cells(b), strict=False)) for b in data[:allowed]]
        batches = [
            (start, rows[start : start + self._settings.batch_rows])
            for start in range(0, allowed, self._settings.batch_rows)
        ]
        answers = await asyncio.gather(
            *(self._describe(user_id, summary, batch, slots) for _, batch in batches)
        )
        described = 0
        for (start, _), texts in zip(batches, answers, strict=True):
            for offset, text in enumerate(texts):
                if text:
                    block = data[start + offset]
                    block.data = {**block.data, "text": text, "plain": block.data["text"]}
                    described += 1
        return described

    async def _describe(
        self,
        user_id: str,
        summary: str,
        rows: list[dict[str, str]],
        slots: asyncio.Semaphore,
        split: bool = True,
    ) -> list[str | None]:
        """A sentence per row, matched by key; None where the model gave none."""
        keys = row_keys(rows)
        keyed = "\n".join(
            f"[{key}]: {json.dumps(_cut(row), ensure_ascii=False)}"
            for key, row in zip(keys, rows, strict=True)
        )
        try:
            async with slots:
                answer = await self._llm.json(
                    user_id,
                    [
                        {"role": "system", "content": ROW_TEXT_SYSTEM},
                        {
                            "role": "user",
                            "content": ROW_TEXT_PROMPT.format(
                                table_summary=summary, row_count=len(rows), keyed_rows=keyed
                            ),
                        },
                    ],
                    "row_descriptions",
                    ROWS_SCHEMA,
                    max_output_tokens=self._settings.max_output_tokens,
                )
        except OutOfCreditsError:
            raise
        except LlmUnavailableError as err:
            logger.warning("row descriptions failed; plain rows", extra={"why": str(err)})
            return [None] * len(rows)
        texts = align_by_key(answer.get("descriptions") or [], keys)
        missing = sum(1 for t in texts if t is None)
        if missing > len(rows) * ROW_MISS_TOLERANCE and split and len(rows) >= 2 * MIN_SPLIT_ROWS:
            # Asked again in halves; only the rows still missing fall back.
            mid = len(rows) // 2
            left, right = await asyncio.gather(
                self._describe(user_id, summary, rows[:mid], slots, split=False),
                self._describe(user_id, summary, rows[mid:], slots, split=False),
            )
            return [t or again for t, again in zip(texts, left + right, strict=True)]
        return texts


def _tables(container: BlocksContainer) -> list[_Table]:
    tables = []
    for group in container.block_groups:
        if group.type != GroupType.TABLE:
            continue
        rows = [container.blocks[i] for i in group.children.block_indices()]
        rows = [b for b in rows if isinstance(b.data, dict) and b.data.get("cells")]
        if rows:
            tables.append(_Table(group, rows))
    return tables


def _numbered(rows: list[list[str]]) -> str:
    return "\n".join(
        f"Row {i}: {json.dumps([_cut_cell(c) or None for c in row], ensure_ascii=False)}"
        for i, row in enumerate(rows, start=1)
    )


def _cut_cell(cell: str) -> str:
    return cell[:PROMPT_CELL_CHARS]


def _cut(row: dict[str, str]) -> dict[str, str]:
    return {k: _cut_cell(v) for k, v in row.items() if v}


def _headers(header_rows: list[list[str]], proposed: list[Any], width: int) -> list[str]:
    """One unique name per column: header rows joined top to bottom (a group label over its
    sub-labels), else the model's names when it gave one per column, else Column_N."""
    if header_rows:
        names = []
        for col in range(width):
            parts = [row[col] for row in header_rows if col < len(row) and row[col]]
            names.append(" - ".join(dict.fromkeys(parts)))
    elif len(proposed) == width:
        names = [str(p).strip() for p in proposed]
    else:
        names = [""] * width
    return _unique([n or f"Column_{i + 1}" for i, n in enumerate(names)])


def _unique(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for name in names:
        seen[name] = seen.get(name, 0) + 1
        out.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return out


def _plain_summary(headers: list[str], rows: int) -> str:
    return f"A table with {rows} row{'' if rows == 1 else 's'} and columns: {', '.join(headers)}."


def row_keys(rows: list[dict[str, str]]) -> list[str]:
    """A short opaque key per row, from a hash of the batch: the same batch gets the same keys
    (so the proxy's cache holds across retries), and no two keys are one typo apart."""
    seed = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    keys: list[str] = []
    counter = 0
    while len(keys) < len(rows):
        digest = hashlib.sha256(f"{seed}:{counter}".encode()).digest()
        value = int.from_bytes(digest[:3], "big")
        key = "".join(KEY_ALPHABET[(value >> (5 * i)) & 31] for i in range(KEY_CHARS))
        counter += 1
        if all(sum(a != b for a, b in zip(key, other, strict=True)) >= 2 for other in keys):
            keys.append(key)
    return keys


def align_by_key(entries: list[Any], keys: list[str]) -> list[str | None]:
    """Each row's description by its copied key; the answer's order and length don't matter."""
    index = {key: i for i, key in enumerate(keys)}
    texts: list[str | None] = [None] * len(keys)
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key", "")).strip().strip("[]\"'` ").upper()
        text = str(entry.get("description") or "").strip()
        i = index.get(key)
        if i is not None and texts[i] is None and text:
            texts[i] = text
    return texts
