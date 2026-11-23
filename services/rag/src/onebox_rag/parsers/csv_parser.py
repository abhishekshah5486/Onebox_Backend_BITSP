import csv
import io

from onebox_rag.models.blocks import DataFormat
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.tables import add_table, looks_like_header
from onebox_rag.parsers.text_decoding import decode_text

_SAMPLE = 64 * 1024


def parse_csv(data: bytes, mime_type: str = "", *, delimiter: str | None = None) -> ParseResult:
    """One table, a row block per line. Headers come from csv.Sniffer for now; the LLM header
    detection and row sentences arrive with spreadsheets (milestone 8)."""
    text = decode_text(data)
    sample = text[:_SAMPLE]
    sniffer = csv.Sniffer()
    try:
        dialect: type[csv.Dialect] | csv.Dialect = sniffer.sniff(sample, delimiters=delimiter)
    except csv.Error:
        dialect = csv.excel_tab if delimiter == "\t" else csv.excel
    try:
        has_header = sniffer.has_header(sample)
    except csv.Error:
        has_header = False

    reader = csv.reader(io.StringIO(text), dialect)
    rows: list[list[str]] = []
    lines: list[int] = []
    for row in reader:
        if any(cell.strip() for cell in row):
            rows.append(row)
            lines.append(reader.line_num)
    header = rows.pop(0) if rows and (has_header or looks_like_header(rows[0])) else []
    if header:
        lines.pop(0)
    out = BlocksBuilder()
    add_table(out, header, rows, row_lines=lines, format=DataFormat.CSV)
    return ParseResult(out.build())


def parse_tsv(data: bytes, mime_type: str = "") -> ParseResult:
    return parse_csv(data, mime_type, delimiter="\t")
