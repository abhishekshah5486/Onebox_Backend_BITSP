"""A DoclingDocument (as a dict) to blocks, walking its body in reading order like PipesHub."""

from typing import Any

from onebox_rag.models.blocks import (
    BlockGroup,
    BlocksContainer,
    BlockSubType,
    BlockType,
    DataFormat,
    GroupType,
    ImageMetadata,
    ListMetadata,
    Point,
)
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.tables import add_table

_HEADINGS = {"title", "section_header"}
_SUB_TYPES = {
    "list_item": BlockSubType.LIST_ITEM,
    "code": BlockSubType.CODE,
    "formula": BlockSubType.EQUATION,
}
_GROUPS = {
    "list": GroupType.LIST,
    "ordered_list": GroupType.ORDERED_LIST,
    "inline": GroupType.INLINE,
    "key_value_area": GroupType.KEY_VALUE_AREA,
    "form_area": GroupType.KEY_VALUE_AREA,
}


class _Walk:
    def __init__(self, doc: dict[str, Any], slides: bool) -> None:
        self.doc, self.slides = doc, slides
        self.out = BlocksBuilder()
        # Captions and footnotes read into their table or picture, never as text of their own.
        self.attached: set[str] = set()
        self.seen: set[str] = set()

    def resolve(self, ref: Any) -> dict[str, Any] | None:
        path = ref.get("$ref", "") if isinstance(ref, dict) else ""
        parts = path.split("/")
        if len(parts) != 3 or parts[0] != "#":
            return None
        try:
            item: dict[str, Any] = self.doc.get(parts[1], [])[int(parts[2])]
        except (IndexError, ValueError):
            return None
        return item

    def texts(self, refs: list[Any]) -> list[str]:
        found = []
        for ref in refs:
            item = self.resolve(ref)
            if item is not None and item.get("text"):
                self.attached.add(item["self_ref"])
                found.append(item["text"])
        return found

    def citation(self, item: dict[str, Any]) -> dict[str, Any]:
        """Page (or slide) and the first box, normalized to the page with the origin top left."""
        prov = item.get("prov") or []
        if not prov:
            return {}
        page_no = prov[0].get("page_no")
        fields: dict[str, Any] = {"slide_number" if self.slides else "page_number": page_no}
        more = sorted({p["page_no"] for p in prov[1:] if p.get("page_no") not in (None, page_no)})
        if more:
            fields["more_page_numbers"] = more
        size = (self.doc.get("pages", {}).get(str(page_no)) or {}).get("size") or {}
        box, width, height = prov[0].get("bbox"), size.get("width"), size.get("height")
        if box and width and height:
            top, bottom = box["t"], box["b"]
            if box.get("coord_origin", "BOTTOMLEFT") != "TOPLEFT":
                top, bottom = height - top, height - bottom
            left, right = box["l"] / width, box["r"] / width
            top, bottom = top / height, bottom / height
            fields["bounding_boxes"] = [
                Point(x=left, y=top),
                Point(x=right, y=top),
                Point(x=right, y=bottom),
                Point(x=left, y=bottom),
            ]
        return fields

    def walk(self, ref: Any, parent: BlockGroup | None) -> None:
        item = self.resolve(ref)
        if item is None or item["self_ref"] in self.seen:
            return
        self.seen.add(item["self_ref"])
        if item.get("content_layer", "body") != "body":
            return  # page headers, footers and other furniture
        kind = item["self_ref"].split("/")[1]
        if kind == "tables":
            self.table(item, parent)
            return
        if kind == "pictures":
            self.picture(item, parent)
            return
        if kind == "groups":
            group_type = _GROUPS.get(item.get("label", ""))
            if group_type is not None:
                ordered = group_type == GroupType.ORDERED_LIST
                lists = {GroupType.LIST, GroupType.ORDERED_LIST}
                parent = self.out.group(
                    group_type,
                    parent=parent,
                    list_metadata=ListMetadata(list_style="numbered" if ordered else "bullet")
                    if group_type in lists
                    else None,
                )
        elif kind == "texts" and item["self_ref"] not in self.attached:
            self.text(item, parent)
        for child in item.get("children", []):
            self.walk(child, parent)

    def text(self, item: dict[str, Any], parent: BlockGroup | None) -> None:
        text = (item.get("text") or "").strip()
        if not text:
            return
        label = item.get("label", "text")
        if label in _HEADINGS:
            # A title opens the document; section headers carry Docling's level (1 is top).
            self.out.heading(0 if label == "title" else item.get("level") or 1, text)
            sub_type = BlockSubType.HEADING
        else:
            sub_type = _SUB_TYPES.get(label, BlockSubType.PARAGRAPH)
        block_type = BlockType.CODE if label == "code" else BlockType.TEXT
        self.out.block(
            block_type,
            text,
            parent=parent,
            sub_type=sub_type,
            citation_metadata=self.out.citation(**self.citation(item)),
        )

    def table(self, item: dict[str, Any], parent: BlockGroup | None) -> None:
        grid = [[(cell.get("text") or "").strip() for cell in row] for row in item["data"]["grid"]]
        flags = item["data"]["grid"]
        # Leading rows that are all column headers make the header (joined when stacked).
        header_rows = 0
        while header_rows < len(flags) and all(c.get("column_header") for c in flags[header_rows]):
            header_rows += 1
        header = [
            " / ".join(dict.fromkeys(r[col] for r in grid[:header_rows] if r[col]))
            for col in range(len(grid[0]) if grid else 0)
        ]
        rows = [row for row in grid[header_rows:] if any(row)]
        if not rows and not any(header):
            for child in item.get("children", []):
                self.walk(child, parent)
            return
        citation = self.citation(item)
        table = add_table(self.out, header if header_rows else [], rows, parent=parent, **citation)
        assert table.table_metadata is not None
        table.table_metadata.captions = self.texts(item.get("captions", []))
        table.table_metadata.footnotes = self.texts(item.get("footnotes", []))
        # Pictures and notes Docling nests under a table follow it; captions are skipped.
        for child in item.get("children", []):
            self.walk(child, parent)

    def picture(self, item: dict[str, Any], parent: BlockGroup | None) -> None:
        captions = self.texts(item.get("captions", []))
        uri = (item.get("image") or {}).get("uri")
        if not uri and not captions:
            return
        self.out.block(
            BlockType.IMAGE,
            uri,
            parent=parent,
            format=DataFormat.BASE64,
            image_metadata=ImageMetadata(
                captions=captions, image_format=(item.get("image") or {}).get("mimetype")
            ),
            citation_metadata=self.out.citation(**self.citation(item)),
        )
        # Text Docling found inside a picture (chart labels, say) still reads as text.
        for child in item.get("children", []):
            self.walk(child, parent)


def docling_to_blocks(doc: dict[str, Any], *, slides: bool = False) -> BlocksContainer:
    """`slides` cites slide numbers instead of pages (PowerPoint)."""
    walk = _Walk(doc, slides)
    for child in doc.get("body", {}).get("children", []):
        walk.walk(child, None)
    return walk.out.build()


def parse_docling_document(doc: dict[str, Any], slides: bool) -> ParseResult:
    """Run in a parse worker, so building blocks for a big document never stalls the service."""
    return ParseResult(docling_to_blocks(doc, slides=slides))
