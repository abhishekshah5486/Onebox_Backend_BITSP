from onebox_rag.models.blocks import BlocksContainer, BlockSubType, BlockType, GroupType
from onebox_rag.parsers.pdf.pdfplumber_engine import parse_pdf_layout
from tests.pdf_samples import grid_in_image, handbook


def texts(container: BlocksContainer, page: int) -> list[str]:
    return [
        b.text()
        for b in container.blocks
        if b.citation_metadata is not None and b.citation_metadata.page_number == page
    ]


def test_reads_a_handbook_like_a_person_would() -> None:
    container = parse_pdf_layout(handbook()).container
    assert container.problems() == []
    headings = [b.text() for b in container.blocks if b.sub_type == BlockSubType.HEADING]
    assert headings[:3] == ["Returns and refunds", "Eligibility", "Plans"]
    plans = next(b for b in container.blocks if b.text().startswith("Plan: Pro"))
    assert plans.citation_metadata is not None
    assert plans.citation_metadata.heading_path == ["Returns and refunds", "Plans"]
    # A bullet list and a numbered list, each its own group.
    lists = [
        g for g in container.block_groups if g.type in (GroupType.LIST, GroupType.ORDERED_LIST)
    ]
    items = [[container.blocks[i].text() for i in g.children.block_indices()] for g in lists]
    assert [g.type for g in lists] == [GroupType.LIST, GroupType.ORDERED_LIST]
    assert items == [
        ["Unworn items only", "Tags still attached", "Receipt or order number"],
        ["Print the label", "Pack the item", "Drop it off"],
    ]
    # The ruled table and the borderless one, each with its header.
    rows = [b.text() for b in container.blocks if b.type == BlockType.TABLE_ROW]
    assert "Plan: Basic, Return window: 14 days, Price: $0" in rows
    assert "Region: Islands, Carrier: Parcelforce, Cost: 9.90" in rows
    image = next(b for b in container.blocks if b.type == BlockType.IMAGE)
    assert image.image_metadata is not None
    assert image.image_metadata.captions == ["Figure 1: Returns by quarter"]
    assert str(image.data).startswith("data:image/png;base64,")


def test_drops_running_headers_and_page_numbers_and_reads_columns_in_order() -> None:
    container = parse_pdf_layout(handbook()).container
    every = [t for page in range(1, 6) for t in texts(container, page)]
    # The running header stays once, as it may be said nowhere else; page numbers never.
    assert every.count("Acme Returns Handbook") == 1
    assert not any(t.isdigit() for t in every)
    page = texts(container, 4)
    assert [t.split(":")[0] for t in page[1:]] == [
        *(f"Left 4.{k}" for k in range(4)),
        *(f"Right 4.{k}" for k in range(4)),
    ]
    assert all(t.endswith("inspected.") for t in page[1:])
    heading = container.blocks[0].citation_metadata
    assert heading is not None and heading.page_number == 1
    assert heading.bounding_boxes is not None and 0 <= heading.bounding_boxes[0].y < 0.1


def test_finds_ruled_tables_on_the_raster_that_have_no_vector_rules() -> None:
    rows = [b.text() for b in parse_pdf_layout(grid_in_image()).container.blocks]
    assert rows == [
        "Store: Kings Cross, City: London, Opens: 08:00",
        "Store: Deansgate, City: Manchester, Opens: 09:00",
        "Store: Broad St, City: Birmingham, Opens: 09:30",
    ]
