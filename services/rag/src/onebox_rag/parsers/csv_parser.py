import csv
import io

from onebox_rag.models.blocks import DataFormat
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.sheets import add_sheet_table, find_tables, guess_header_rows
from onebox_rag.parsers.text_decoding import decode_text

_SAMPLE = 64 * 1024


def parse_csv(data: bytes, mime_type: str = "", *, delimiter: str | None = None) -> ParseResult:
    """Every table in the file (blocks of rows split by empty rows or columns), each row cited
    to its record and line. Headers are guessed here; table enrichment decides them."""
    text = decode_text(data)
    sample = text[:_SAMPLE]
    sniffer = csv.Sniffer()
    try:
        dialect: type[csv.Dialect] | csv.Dialect = sniffer.sniff(sample, delimiters=delimiter)
    except csv.Error:
        dialect = csv.excel_tab if delimiter == "\t" else csv.excel
    try:
        sniffed_header = sniffer.has_header(sample)
    except csv.Error:
        sniffed_header = False

    reader = csv.reader(io.StringIO(text), dialect)
    grid: list[list[str]] = []
    lines: list[int] = []
    for row in reader:
        grid.append(row)
        lines.append(reader.line_num)
    out = BlocksBuilder()
    for table in find_tables(grid):

        def guess(rows: list[list[str]], at_top: bool = table.top == 0) -> int:
            # The sniffer looked at the file's start, so it speaks only for a table there.
            if at_top and sniffed_header and len(rows) > 1:
                return 1
            return guess_header_rows(rows)

        def cite(i: int, _width: int, top: int = table.top) -> dict[str, int]:
            return {"row_number": top + i + 1, "line_number": lines[top + i]}

        add_sheet_table(out, table, guess_header=guess, format=DataFormat.CSV, cite=cite)
    return ParseResult(out.build())


def parse_tsv(data: bytes, mime_type: str = "") -> ParseResult:
    return parse_csv(data, mime_type, delimiter="\t")
