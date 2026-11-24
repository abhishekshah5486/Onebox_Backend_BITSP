from onebox_rag.index.points import PointKind, SplitSettings, point_texts
from onebox_rag.index.texts import image_text, without_urls
from onebox_rag.models.blocks import Block, BlockType, ImageMetadata, SemanticMetadata
from onebox_rag.parsers.csv_parser import parse_csv
from onebox_rag.parsers.excel import parse_excel
from onebox_rag.parsers.markdown import parse_markdown
from tests.test_excel import workbook


def test_points_per_block_table_and_long_text() -> None:
    table = parse_csv(b"region,revenue\nnorth,120\nsouth,95\n").container
    table.block_groups[0].semantic_metadata = SemanticMetadata(summary="Revenue by region.")
    points = point_texts(table, SplitSettings())
    # Header rows aren't points of their own; the table point carries the columns.
    assert [(p.kind, p.text) for p in points] == [
        (PointKind.BLOCK, "region: north, revenue: 120"),
        (PointKind.BLOCK, "region: south, revenue: 95"),
        (PointKind.TABLE, "Revenue by region."),
    ]
    assert {p.group_index for p in points} == {0}

    body = " ".join(
        f"Refund {n} takes thirty days from delivery to reach the original card." for n in range(20)
    )
    text = parse_markdown(body.encode()).container
    kinds = [p.kind for p in point_texts(text, SplitSettings())]
    assert kinds == [PointKind.BLOCK] + [PointKind.SENTENCE] * 20
    windows = point_texts(text, SplitSettings(max_block_chars=1000, window_chars=500))
    assert {p.kind for p in windows} == {PointKind.WINDOW} and len(windows) == 4
    assert len({p.point_id("c1", 1) for p in windows}) == 4


def test_rows_are_led_by_their_sheet_and_title() -> None:
    texts = [p.text for p in point_texts(parse_excel(workbook()).container, SplitSettings())]
    assert (
        "Q3 sales - Quarterly sales: Region: North, Month: 2024-07-01, Revenue: 1200, "
        "Growth: 12.5%" in texts
    )
    assert "Q3 sales: Owner: Priya" in texts  # a second table on the sheet, no title of its own
    assert "Raw: 2023, 410" in texts


def test_embedded_text_drops_url_targets_and_keeps_alt_text() -> None:
    assert without_urls("See https://acme.com/help?id=4. Or <http://x.org/a>") == (
        "See acme.com. Or x.org"
    )
    chart = Block(
        id="b0",
        index=0,
        type=BlockType.IMAGE,
        image_metadata=ImageMetadata(description="A bar chart.", alt_text="Revenue FY26"),
    )
    assert image_text(chart) == "A bar chart. Revenue FY26"
