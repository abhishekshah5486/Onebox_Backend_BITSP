from collections.abc import Callable
from dataclasses import dataclass

from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.csv_parser import parse_csv, parse_tsv
from onebox_rag.parsers.email import parse_email
from onebox_rag.parsers.epub import EPUB as EPUB_TYPE
from onebox_rag.parsers.epub import parse_epub
from onebox_rag.parsers.excel import EXCEL_TYPES, parse_excel
from onebox_rag.parsers.html import parse_html
from onebox_rag.parsers.markdown import parse_markdown
from onebox_rag.parsers.plain_text import parse_plain_text
from onebox_rag.parsers.structured import parse_json, parse_yaml


@dataclass(frozen=True)
class Parser:
    # Recorded per revision, so a retry or re-index uses the same one.
    engine: str
    # (bytes, mime type) -> blocks; runs in a parse worker, so it must pickle by reference.
    parse: Callable[[bytes, str], ParseResult]


MARKDOWN = Parser("markdown-it", parse_markdown)
HTML = Parser("selectolax", parse_html)
EMAIL = Parser("email", parse_email)
JSON = Parser("json", parse_json)
YAML = Parser("yaml", parse_yaml)
CSV = Parser("csv", parse_csv)
TSV = Parser("tsv", parse_tsv)
PLAIN_TEXT = Parser("plain-text", parse_plain_text)
EXCEL = Parser("openpyxl", parse_excel)
EPUB = Parser("epub", parse_epub)

_BY_MIME = {
    "text/markdown": MARKDOWN,
    "text/x-markdown": MARKDOWN,
    # Plain .txt goes through the Markdown path.
    "text/plain": MARKDOWN,
    "text/html": HTML,
    "application/xhtml+xml": HTML,
    "message/rfc822": EMAIL,
    "application/json": JSON,
    "application/ld+json": JSON,
    "application/x-ndjson": JSON,
    "application/yaml": YAML,
    "application/x-yaml": YAML,
    "text/yaml": YAML,
    "text/x-yaml": YAML,
    "text/csv": CSV,
    "text/tab-separated-values": TSV,
    **dict.fromkeys(EXCEL_TYPES, EXCEL),
    EPUB_TYPE: EPUB,
}


def parser_for(mime_type: str) -> Parser | None:
    """The parser for a type, or None when it can't be read yet (later milestones add more)."""
    mime = mime_type.split(";")[0].strip().lower()
    if mime in _BY_MIME:
        return _BY_MIME[mime]
    if mime.endswith("+json"):
        return JSON
    if mime.endswith("+yaml"):
        return YAML
    # Other text (logs, config, source code, XML) is read as plain text.
    if mime.startswith("text/") or mime.endswith("+xml") or mime == "application/xml":
        return PLAIN_TEXT
    return None
