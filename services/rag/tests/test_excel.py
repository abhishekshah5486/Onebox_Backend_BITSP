import io
from datetime import date, datetime

import openpyxl
from openpyxl.styles import Font

from onebox_rag.models.blocks import BlockType, GroupType
from onebox_rag.parsers.excel import parse_excel
from onebox_rag.parsers.registry import parser_for

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def workbook() -> bytes:
    book = openpyxl.Workbook()
    sales = book.active
    sales.title = "Q3 sales"
    sales["B2"] = "Quarterly sales"
    sales.merge_cells("B2:E2")
    sales.append([])
    sales.append([None, "Region", "Month", "Revenue", "Growth"])
    for cell in sales[4]:
        cell.font = Font(bold=True)
    sales.append([None, "North", datetime(2024, 7, 1), 1200.0, 0.125])
    sales.append([None, None, date(2024, 8, 1), 1350, 0.05])
    sales.merge_cells("B5:B6")
    for row in (5, 6):
        sales.cell(row, 5).number_format = "0.0%"
    # Notes beside the table, past an empty column.
    sales["G4"], sales["G5"] = "Owner", "Priya"
    # A styled but empty far-away cell must not stretch the sheet.
    sales["Z5000"].font = Font(italic=True)
    book.create_sheet("Empty")
    raw = book.create_sheet("Raw")
    raw.append([2023, 410])
    raw.append([2024, 455])
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def test_reads_each_sheet_into_cited_tables() -> None:
    assert parser_for(XLSX) is not None
    doc = parse_excel(workbook(), XLSX).container
    assert doc.problems() == []
    sheets = [g for g in doc.block_groups if g.type == GroupType.SHEET]
    assert [g.name for g in sheets] == ["Q3 sales", "Raw"]
    assert [b.text() for b in doc.blocks if b.type == BlockType.TEXT] == ["Quarterly sales"]
    rows = [b for b in doc.blocks if b.type == BlockType.TABLE_ROW]
    assert [b.text() for b in rows] == [
        "Region | Month | Revenue | Growth",
        "Region: North, Month: 2024-07-01, Revenue: 1200, Growth: 12.5%",
        # The merged region names both of its rows.
        "Region: North, Month: 2024-08-01, Revenue: 1350, Growth: 5%",
        "Owner",
        "Owner: Priya",
        "2023, 410",
        "2024, 455",
    ]
    first = rows[1].citation_metadata
    assert first is not None
    assert (first.sheet_name, first.sheet_number, first.row_number, first.cell_reference) == (
        "Q3 sales",
        1,
        5,
        "B5:E5",
    )
    raw = rows[-1].citation_metadata
    assert raw is not None and (raw.sheet_number, raw.cell_reference) == (3, "A2:B2")
