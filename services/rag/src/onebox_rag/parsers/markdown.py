"""Markdown (and plain .txt) to blocks by walking markdown-it tokens."""

from markdown_it import MarkdownIt
from markdown_it.token import Token
from selectolax.lexbor import LexborHTMLParser

from onebox_rag.models.blocks import (
    BlockGroup,
    BlocksContainer,
    BlockSubType,
    BlockType,
    CodeMetadata,
    DataFormat,
    GroupType,
    ImageMetadata,
    ListMetadata,
)
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.tables import add_table
from onebox_rag.parsers.text_decoding import decode_text

_MD = MarkdownIt("commonmark").enable("table").enable("strikethrough")


def parse_markdown(data: bytes, mime_type: str = "") -> ParseResult:
    return ParseResult(markdown_to_blocks(decode_text(data)))


def plain(inline: Token) -> str:
    """An inline token's text without markup; images become their alt text."""
    parts: list[str] = []
    for child in inline.children or []:
        if child.type in {"text", "code_inline"}:
            parts.append(child.content)
        elif child.type in {"softbreak", "hardbreak"}:
            parts.append(" ")
        elif child.type == "image":
            parts.append(child.content)
        elif child.type == "html_inline":
            continue
    return "".join(parts).strip()


def _images(inline: Token) -> list[tuple[str, str]]:
    return [
        (child.content, str(child.attrs.get("src", "")))
        for child in inline.children or []
        if child.type == "image"
    ]


def _line(token: Token) -> int | None:
    return token.map[0] + 1 if token.map else None


class _Walker:
    def __init__(self, tokens: list[Token]) -> None:
        self.tokens = tokens
        self.out = BlocksBuilder()
        # Open list groups and blockquote depth.
        self.lists: list[BlockGroup] = []
        self.quote = 0

    def walk(self) -> BlocksContainer:
        i = 0
        while i < len(self.tokens):
            i = self.step(i)
        return self.out.build()

    def step(self, i: int) -> int:
        token = self.tokens[i]
        kind = token.type
        if kind == "heading_open":
            inline = self.tokens[i + 1]
            text = plain(inline)
            self.out.heading(int(token.tag[1:]), text)
            self.out.text(
                text,
                sub_type=BlockSubType.HEADING,
                format=DataFormat.MARKDOWN,
                citation_metadata=self.out.citation(line_number=_line(token)),
            )
            return i + 3
        if kind in {"bullet_list_open", "ordered_list_open"}:
            ordered = kind == "ordered_list_open"
            self.lists.append(
                self.out.group(
                    GroupType.ORDERED_LIST if ordered else GroupType.LIST,
                    parent=self.lists[-1] if self.lists else None,
                    list_metadata=ListMetadata(
                        list_style="numbered" if ordered else "bullet",
                        indent_level=len(self.lists),
                    ),
                )
            )
            return i + 1
        if kind in {"bullet_list_close", "ordered_list_close"}:
            self.lists.pop()
            return i + 1
        if kind == "blockquote_open":
            self.quote += 1
            return i + 1
        if kind == "blockquote_close":
            self.quote -= 1
            return i + 1
        if kind == "paragraph_open":
            self.paragraph(token, self.tokens[i + 1])
            return i + 3
        if kind in {"fence", "code_block"}:
            self.out.block(
                BlockType.CODE,
                token.content.rstrip("\n"),
                sub_type=BlockSubType.CODE,
                format=DataFormat.CODE,
                parent=self.lists[-1] if self.lists else None,
                code_metadata=CodeMetadata(language=token.info.strip() or None),
                citation_metadata=self.out.citation(line_number=_line(token)),
            )
            return i + 1
        if kind == "html_block":
            text = LexborHTMLParser(token.content).text(separator=" ")
            self.out.text(
                " ".join(text.split()),
                citation_metadata=self.out.citation(line_number=_line(token)),
            )
            return i + 1
        if kind == "table_open":
            return self.table(i)
        return i + 1

    def paragraph(self, opening: Token, inline: Token) -> None:
        parent = self.lists[-1] if self.lists else None
        cite = self.out.citation(line_number=_line(opening))
        for alt, src in _images(inline):
            self.out.block(
                BlockType.IMAGE,
                None,
                parent=parent,
                links=[src] if src else None,
                image_metadata=ImageMetadata(alt_text=alt or None),
                citation_metadata=cite,
            )
        if parent is not None:
            sub_type = BlockSubType.LIST_ITEM
        elif self.quote:
            sub_type = BlockSubType.QUOTE
        else:
            sub_type = BlockSubType.PARAGRAPH
        self.out.text(
            inline.content,
            parent=parent,
            sub_type=sub_type,
            format=DataFormat.MARKDOWN,
            citation_metadata=cite,
        )

    def table(self, i: int) -> int:
        start = self.tokens[i]
        rows: list[list[str]] = []
        header: list[str] = []
        lines: list[int] = []
        in_head = False
        row: list[str] = []
        while self.tokens[i].type != "table_close":
            token = self.tokens[i]
            if token.type == "thead_open":
                in_head = True
            elif token.type == "thead_close":
                in_head = False
            elif token.type == "tr_open":
                row = []
                if not in_head:
                    lines.append(_line(token) or 0)
            elif token.type == "inline":
                row.append(plain(token))
            elif token.type == "tr_close":
                if in_head:
                    header = row
                else:
                    rows.append(row)
            i += 1
        add_table(
            self.out,
            header,
            rows,
            parent=self.lists[-1] if self.lists else None,
            first_line=_line(start),
            row_lines=lines,
            format=DataFormat.MARKDOWN,
        )
        return i + 1


def markdown_to_blocks(text: str) -> BlocksContainer:
    return _Walker(_MD.parse(text)).walk()
