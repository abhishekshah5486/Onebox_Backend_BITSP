"""JSON and YAML to blocks, deterministically (no LLM):
flat fields become one "key: value" block, nested objects become KEY_VALUE_AREA groups,
arrays of objects become tables with a row per item, and long strings get their own block."""

import json
from typing import Any

import yaml

from onebox_rag.models.blocks import BlockGroup, BlocksContainer, DataFormat, GroupType
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.plain_text import plain_text_to_blocks
from onebox_rag.parsers.tables import add_table
from onebox_rag.parsers.text_decoding import decode_text

# Strings longer than this read as prose, so they are not squeezed into a field list.
LONG_TEXT = 200


def parse_json(data: bytes, mime_type: str = "") -> ParseResult:
    text = decode_text(data)
    try:
        docs = [json.loads(text)]
    except json.JSONDecodeError:
        try:
            # JSON Lines: one value per line.
            docs = [[json.loads(line) for line in text.splitlines() if line.strip()]]
        except json.JSONDecodeError:
            return ParseResult(plain_text_to_blocks(text))
    return ParseResult(structured_to_blocks(docs, DataFormat.JSON))


def parse_yaml(data: bytes, mime_type: str = "") -> ParseResult:
    text = decode_text(data)
    try:
        docs = [doc for doc in yaml.safe_load_all(text) if doc is not None]
    except yaml.YAMLError:
        return ParseResult(plain_text_to_blocks(text))
    return ParseResult(structured_to_blocks(docs, DataFormat.YAML))


def _scalar(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def _is_scalar(value: Any) -> bool:
    return not isinstance(value, (dict, list))


class _Walker:
    def __init__(self, format: DataFormat) -> None:
        self.out = BlocksBuilder()
        self.format = format

    def value(self, value: Any, path: list[str], parent: BlockGroup | None) -> None:
        if isinstance(value, dict):
            self.mapping(value, path, parent)
        elif isinstance(value, list):
            self.sequence(value, path, parent)
        else:
            self.text(_scalar(value), path, parent)

    def text(self, text: str, path: list[str], parent: BlockGroup | None) -> None:
        self.out.text(
            text,
            parent=parent,
            format=self.format,
            citation_metadata=self.out.citation().model_copy(
                update={"heading_path": path, "section_title": path[-1] if path else None}
            ),
        )

    def mapping(self, value: dict[Any, Any], path: list[str], parent: BlockGroup | None) -> None:
        flat = []
        for key, item in value.items():
            if _is_scalar(item) and len(str(item)) <= LONG_TEXT:
                flat.append(f"{key}: {item}")
            elif isinstance(item, list) and all(_is_scalar(i) for i in item):
                flat.append(f"{key}: {', '.join(map(str, item))}")
        self.text(", ".join(flat), path, parent)
        for key, item in value.items():
            child_path = [*path, str(key)]
            if _is_scalar(item) and len(str(item)) > LONG_TEXT:
                self.text(f"{key}: {item}", child_path, parent)
            elif isinstance(item, dict):
                group = self.out.group(
                    GroupType.KEY_VALUE_AREA, parent=parent, name=str(key), format=self.format
                )
                self.mapping(item, child_path, group)
            elif isinstance(item, list) and not all(_is_scalar(i) for i in item):
                self.sequence(item, child_path, parent)

    def sequence(self, value: list[Any], path: list[str], parent: BlockGroup | None) -> None:
        records = [item for item in value if isinstance(item, dict)]
        if records and len(records) == len(value):
            columns = list(dict.fromkeys(str(k) for item in records for k in item))
            rows = [[_scalar(item.get(c, "")) for c in columns] for item in records]
            add_table(
                self.out,
                columns,
                rows,
                parent=parent,
                name=path[-1] if path else None,
                format=self.format,
            )
            return
        scalars = [_scalar(item) for item in value if _is_scalar(item)]
        if scalars:
            label = f"{path[-1]}: " if path else ""
            self.text(label + ", ".join(scalars), path, parent)
        for number, item in enumerate(value, start=1):
            if not _is_scalar(item):
                self.value(item, [*path, str(number)], parent)


def structured_to_blocks(docs: list[Any], format: DataFormat) -> BlocksContainer:
    walker = _Walker(format)
    for doc in docs:
        walker.value(doc, [], None)
    return walker.out.build()
