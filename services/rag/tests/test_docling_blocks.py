from typing import Any

from onebox_rag.models.blocks import BlockSubType, BlockType, GroupType
from onebox_rag.parsers.docling_blocks import docling_to_blocks


def ref(path: str) -> dict[str, str]:
    return {"$ref": path}


def text(i: int, label: str, value: str, **extra: Any) -> dict[str, Any]:
    return {"self_ref": f"#/texts/{i}", "label": label, "text": value, "children": [], **extra}


def on_page(
    page: int, left: float, top: float, right: float, bottom: float
) -> list[dict[str, Any]]:
    bbox = {"l": left, "t": top, "r": right, "b": bottom, "coord_origin": "BOTTOMLEFT"}
    return [{"page_no": page, "bbox": bbox}]


# Shaped like Docling's export: a body tree of refs into texts, groups, tables and pictures.
DOC: dict[str, Any] = {
    "body": {"children": [ref("#/texts/0"), ref("#/groups/0"), ref("#/tables/0")]},
    "pages": {"1": {"size": {"width": 200, "height": 100}, "page_no": 1}},
    "texts": [
        text(0, "section_header", "Refunds", level=1, prov=on_page(1, 20, 90, 120, 80)),
        text(1, "list_item", "Within thirty days"),
        text(2, "list_item", "Original packaging"),
        text(3, "caption", "Table 1: plans"),
        text(4, "page_footer", "Page 1 of 9", content_layer="furniture"),
        text(5, "section_header", "Plans", level=2),
        text(6, "caption", "Figure 1: the returns desk"),
    ],
    "groups": [
        {
            "self_ref": "#/groups/0",
            "label": "list",
            "children": [ref("#/texts/1"), ref("#/texts/2"), ref("#/texts/4"), ref("#/texts/5")],
        }
    ],
    "tables": [
        {
            "self_ref": "#/tables/0",
            "label": "table",
            "children": [ref("#/texts/3"), ref("#/pictures/0")],
            "captions": [ref("#/texts/3")],
            "prov": on_page(1, 0, 50, 200, 0),
            "data": {
                "grid": [
                    [
                        {"text": "Plan", "column_header": True},
                        {"text": "Price", "column_header": True},
                    ],
                    [{"text": "Pro"}, {"text": "$10"}],
                    [{"text": ""}, {"text": ""}],
                ]
            },
        }
    ],
    "pictures": [
        {
            "self_ref": "#/pictures/0",
            "label": "picture",
            "children": [ref("#/texts/6")],
            "captions": [ref("#/texts/6")],
            "image": {"uri": "data:image/png;base64,AAAA", "mimetype": "image/png"},
        }
    ],
}


def test_walks_a_docling_document_in_reading_order() -> None:
    container = docling_to_blocks(DOC)
    assert container.problems() == []
    texts = [(b.type, b.sub_type, b.text()) for b in container.blocks]
    assert texts == [
        (BlockType.TEXT, BlockSubType.HEADING, "Refunds"),
        (BlockType.TEXT, BlockSubType.LIST_ITEM, "Within thirty days"),
        (BlockType.TEXT, BlockSubType.LIST_ITEM, "Original packaging"),
        (BlockType.TEXT, BlockSubType.HEADING, "Plans"),
        # The empty row is dropped; captions live on their table or picture, the footer nowhere.
        (BlockType.TABLE_ROW, None, "Plan: Pro, Price: $10"),
        (BlockType.IMAGE, None, "Figure 1: the returns desk"),
    ]
    lists = [g for g in container.block_groups if g.type == GroupType.LIST]
    tables = [g for g in container.block_groups if g.type == GroupType.TABLE]
    assert [container.blocks[i].text() for i in lists[0].children.block_indices()][:2] == [
        "Within thirty days",
        "Original packaging",
    ]
    assert tables[0].table_metadata is not None
    assert tables[0].table_metadata.column_names == ["Plan", "Price"]
    assert tables[0].table_metadata.captions == ["Table 1: plans"]
    image = container.blocks[-1]
    assert image.image_metadata is not None
    assert image.image_metadata.captions == ["Figure 1: the returns desk"]
    row = container.blocks[4].citation_metadata
    assert row is not None and row.heading_path == ["Refunds", "Plans"]


def test_cites_pages_with_boxes_from_the_top_left_or_slides() -> None:
    heading = docling_to_blocks(DOC).blocks[0].citation_metadata
    assert heading is not None and heading.page_number == 1
    assert [(p.x, p.y) for p in heading.bounding_boxes or []] == [
        (0.1, 0.1),
        (0.6, 0.1),
        (0.6, 0.2),
        (0.1, 0.2),
    ]
    slide = docling_to_blocks(DOC, slides=True).blocks[0].citation_metadata
    assert slide is not None and (slide.slide_number, slide.page_number) == (1, None)
