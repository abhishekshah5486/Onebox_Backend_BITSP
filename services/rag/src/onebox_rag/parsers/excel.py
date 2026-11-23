"""Excel workbooks (XLSX, XLSM and templates): each sheet a group of its tables, every row cited
to its sheet, row and cell range."""

import io
from collections.abc import Callable
from datetime import date, datetime, time
from typing import Any

import openpyxl
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from onebox_rag.models.blocks import DataFormat, GroupType
from onebox_rag.parsers.base import ParseResult, UnreadableFileError
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.sheets import add_sheet_table, find_tables

EXCEL_TYPES = frozenset(
    {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
        "application/vnd.ms-excel.sheet.macroEnabled",
        "application/vnd.ms-excel.sheet.macroEnabled.12",
        "application/vnd.ms-excel.template.macroEnabled",
    }
)


def parse_excel(data: bytes, mime_type: str = "") -> ParseResult:
    try:
        # Cached results, not formulas; openpyxl reads XML through defusedxml when installed.
        workbook = openpyxl.load_workbook(
            io.BytesIO(data), data_only=True, keep_links=False, rich_text=False
        )
    except Exception as err:
        raise UnreadableFileError(f"could not open the workbook ({type(err).__name__})") from err
    out = BlocksBuilder()
    try:
        for number, sheet in enumerate(workbook.worksheets, start=1):
            grid, top, left = sheet_grid(sheet)
            tables = find_tables(grid)
            if not tables:
                continue
            group = out.group(
                GroupType.SHEET,
                name=sheet.title,
                citation_metadata=out.citation(sheet_number=number, sheet_name=sheet.title),
            )
            for table in tables:
                cite = _citer(number, sheet.title, table.top + top, table.left + left)
                add_sheet_table(out, table, parent=group, format=DataFormat.CSV, cite=cite)
    finally:
        workbook.close()
    return ParseResult(out.build())


def _citer(
    sheet_number: int, sheet_name: str, top: int, left: int
) -> Callable[[int, int], dict[str, Any]]:
    """Cites a table's i-th row (its top-left cell at 0-based `top`, `left`) by sheet and range."""

    def cite(i: int, width: int) -> dict[str, Any]:
        row = top + i + 1
        first, last = get_column_letter(left + 1), get_column_letter(left + width)
        return {
            "sheet_number": sheet_number,
            "sheet_name": sheet_name,
            "row_number": row,
            "cell_reference": f"{first}{row}:{last}{row}",
        }

    return cite


def sheet_grid(sheet: Worksheet) -> tuple[list[list[str]], int, int]:
    """The sheet's cells as text over the box its values fill (styled empty cells make
    openpyxl's own dimensions far too big), with that box's 0-based top row and left column.
    A merged range's value fills every cell of it, so each row reads on its own."""
    values: dict[tuple[int, int], str] = {}
    # The loaded cells, without creating the empty ones that iter_rows() would.
    for (row, col), cell in sheet._cells.items():
        text = cell_text(cell.value, cell.number_format)
        if text:
            values[(row, col)] = text
    if not values:
        return [], 0, 0
    rows = [r for r, _ in values]
    cols = [c for _, c in values]
    top, bottom, left, right = min(rows), max(rows), min(cols), max(cols)
    for merged in sheet.merged_cells.ranges:
        anchor = values.get((merged.min_row, merged.min_col))
        if anchor is None:
            continue
        for r in range(max(merged.min_row, top), min(merged.max_row, bottom) + 1):
            for c in range(max(merged.min_col, left), min(merged.max_col, right) + 1):
                values[(r, c)] = anchor
    grid = [[""] * (right - left + 1) for _ in range(bottom - top + 1)]
    for (r, c), text in values.items():
        grid[r - top][c - left] = text
    return grid, top - 1, left - 1


def cell_text(value: object, number_format: str = "General") -> str:
    """A cell value as the sheet shows it, for the common formats: dates without a midnight
    time, percentages, and whole numbers without ".0"."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.time() == time(0):
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="minutes" if value.second == 0 else "seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat(timespec="minutes" if value.second == 0 else "seconds")
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int | float):
        if "%" in (number_format or ""):
            return f"{_number(value * 100)}%"
        return _number(value)
    return str(value).strip()


def _number(value: float) -> str:
    rounded = round(value, 10)
    return str(int(rounded)) if float(rounded).is_integer() else repr(rounded)
