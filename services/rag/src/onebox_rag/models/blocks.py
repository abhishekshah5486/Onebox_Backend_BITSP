"""What every parser produces, whatever the format (structure after PipesHub's blocks model).

A container holds two flat lists, blocks and block groups. Every cross-reference is positional:
a block's ``parent_index`` is its group's index, and a group lists its children as ranges of
block and group indices. Tables are groups of row blocks, lists are groups of item blocks, and
citations point at a block's ``citation_metadata`` (page, box, line, sheet, cell, row, slide).
"""

from collections.abc import Sequence
from enum import StrEnum
from typing import Any, Self

from pydantic import Field, field_validator

from onebox_rag.models.base import CamelModel


class BlockType(StrEnum):
    TEXT = "text"
    IMAGE = "image"
    TABLE_ROW = "table_row"
    CODE = "code"
    RECORD_SUMMARY = "record_summary"


class BlockSubType(StrEnum):
    PARAGRAPH = "paragraph"
    HEADING = "heading"
    QUOTE = "quote"
    LIST_ITEM = "list_item"
    CODE = "code"
    EQUATION = "equation"
    LINK = "link"
    MESSAGE = "message"


class DataFormat(StrEnum):
    TXT = "txt"
    MARKDOWN = "markdown"
    HTML = "html"
    JSON = "json"
    YAML = "yaml"
    CSV = "csv"
    CODE = "code"
    # A data URI (images).
    BASE64 = "base64"


class GroupType(StrEnum):
    TEXT_SECTION = "text_section"
    LIST = "list"
    ORDERED_LIST = "ordered_list"
    TABLE = "table"
    SHEET = "sheet"
    KEY_VALUE_AREA = "key_value_area"
    CODE = "code"
    INLINE = "inline"


class GroupSubType(StrEnum):
    RECORD = "record"
    CONTENT = "content"
    QUOTE = "quote"
    HEADERS = "headers"


class Point(CamelModel):
    x: float
    y: float


class CitationMetadata(CamelModel):
    """Where a block came from, precisely enough to show and link the source."""

    section_title: str | None = None
    # Headings above the block, outermost first.
    heading_path: list[str] = Field(default_factory=list)
    page_number: int | None = None
    more_page_numbers: list[int] | None = None
    # The block's four corners on its page.
    bounding_boxes: list[Point] | None = None
    line_number: int | None = None
    paragraph_number: int | None = None
    sheet_number: int | None = None
    sheet_name: str | None = None
    cell_reference: str | None = None
    row_number: int | None = None
    column_number: int | None = None
    slide_number: int | None = None

    @field_validator("bounding_boxes")
    @classmethod
    def _four_corners(cls, boxes: list[Point] | None) -> list[Point] | None:
        if boxes is not None and len(boxes) != 4:
            raise ValueError("bounding_boxes must hold exactly 4 points")
        return boxes


class TableMetadata(CamelModel):
    num_of_rows: int | None = None
    num_of_cols: int | None = None
    has_header: bool = False
    column_names: list[str] | None = None
    captions: list[str] = Field(default_factory=list)
    footnotes: list[str] = Field(default_factory=list)


class TableRowMetadata(CamelModel):
    row_number: int | None = None
    is_header: bool = False


class ListMetadata(CamelModel):
    list_style: str | None = None  # bullet, numbered, checkbox
    indent_level: int = 0
    item_count: int | None = None


class CodeMetadata(CamelModel):
    language: str | None = None


class ImageMetadata(CamelModel):
    # Written at enrichment time by a vision model; the only text form of the image.
    description: str | None = None
    alt_text: str | None = None
    image_format: str | None = None
    captions: list[str] = Field(default_factory=list)


class SemanticMetadata(CamelModel):
    summary: str | None = None
    keywords: list[str] | None = None
    topics: list[str] | None = None


class IndexRange(CamelModel):
    start: int
    end: int  # inclusive


def _ranges(indices: list[int]) -> list[IndexRange]:
    out: list[IndexRange] = []
    for index in sorted(set(indices)):
        if out and out[-1].end == index - 1:
            out[-1].end = index
        else:
            out.append(IndexRange(start=index, end=index))
    return out


def _expand(ranges: list[IndexRange]) -> list[int]:
    return [i for r in ranges for i in range(r.start, r.end + 1)]


class BlockGroupChildren(CamelModel):
    block_ranges: list[IndexRange] = Field(default_factory=list)
    block_group_ranges: list[IndexRange] = Field(default_factory=list)

    @classmethod
    def of(cls, blocks: list[int] | None = None, groups: list[int] | None = None) -> Self:
        return cls(block_ranges=_ranges(blocks or []), block_group_ranges=_ranges(groups or []))

    def block_indices(self) -> list[int]:
        return _expand(self.block_ranges)

    def group_indices(self) -> list[int]:
        return _expand(self.block_group_ranges)


class Block(CamelModel):
    id: str
    index: int
    parent_index: int | None = None
    type: BlockType
    sub_type: BlockSubType | None = None
    format: DataFormat = DataFormat.TXT
    name: str | None = None
    # Text for text and code blocks; for table rows {"text": "col: value, ...", "cells": {...}}.
    data: Any = None
    links: list[str] | None = None
    citation_metadata: CitationMetadata | None = None
    list_metadata: ListMetadata | None = None
    table_row_metadata: TableRowMetadata | None = None
    code_metadata: CodeMetadata | None = None
    image_metadata: ImageMetadata | None = None
    semantic_metadata: SemanticMetadata | None = None

    def text(self) -> str:
        """The block's searchable text; an image's is its description or captions, not its bytes."""
        if self.type == BlockType.IMAGE:
            meta = self.image_metadata
            if meta is None:
                return ""
            return meta.description or " ".join(meta.captions)
        if isinstance(self.data, str):
            return self.data
        if isinstance(self.data, dict):
            return str(self.data.get("text") or "")
        return ""


class BlockGroup(CamelModel):
    id: str
    index: int
    parent_index: int | None = None
    type: GroupType
    sub_type: GroupSubType | None = None
    name: str | None = None
    description: str | None = None
    children: BlockGroupChildren = Field(default_factory=BlockGroupChildren)
    data: Any = None
    format: DataFormat | None = None
    citation_metadata: CitationMetadata | None = None
    table_metadata: TableMetadata | None = None
    list_metadata: ListMetadata | None = None
    semantic_metadata: SemanticMetadata | None = None


class BlocksContainer(CamelModel):
    blocks: list[Block] = Field(default_factory=list)
    block_groups: list[BlockGroup] = Field(default_factory=list)

    def has_text(self) -> bool:
        return any(block.text().strip() for block in self.blocks)

    def problems(self) -> list[str]:
        """Broken positional links, which would point citations at the wrong content."""
        issues: list[str] = []
        pairs: tuple[tuple[str, Sequence[Block | BlockGroup]], ...] = (
            ("block", self.blocks),
            ("group", self.block_groups),
        )
        for kind, items in pairs:
            issues += [
                f"{kind} {i} has index {item.index}"
                for i, item in enumerate(items)
                if item.index != i
            ]
        n_groups = len(self.block_groups)
        everything: list[Block | BlockGroup] = [*self.blocks, *self.block_groups]
        for item in everything:
            if item.parent_index is not None and not 0 <= item.parent_index < n_groups:
                issues.append(f"{item.id} points at missing group {item.parent_index}")
        for group in self.block_groups:
            for i in group.children.block_indices():
                if i >= len(self.blocks) or self.blocks[i].parent_index != group.index:
                    issues.append(f"group {group.index} lists block {i}, not its child")
            for i in group.children.group_indices():
                if i >= n_groups or self.block_groups[i].parent_index != group.index:
                    issues.append(f"group {group.index} lists group {i}, not its child")
        return issues
