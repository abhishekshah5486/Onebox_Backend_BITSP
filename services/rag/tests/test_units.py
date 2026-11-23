from onebox_rag.index.qdrant_store import Hit
from onebox_rag.models.blocks import SemanticMetadata
from onebox_rag.parsers.csv_parser import parse_csv
from onebox_rag.parsers.markdown import parse_markdown
from onebox_rag.retrieval.units import UnitSettings, add_neighbours, build_units, rank

DOC = b"""Before the steps.

- Pack the item
- Print the label

Shipping takes five days.

After shipping.
"""


def hit(content: str, score: float, block: int | None = None, group: int | None = None) -> Hit:
    payload = {"contentId": content, "blockIndex": block, "groupIndex": group}
    return Hit(f"{content}{block}{group}{score}", score, payload)


def test_hits_become_lists_tables_and_blocks() -> None:
    doc = parse_markdown(DOC).container
    table = parse_csv(b"region,revenue\nnorth,120\nsouth,95\neast,80\n").container
    table.block_groups[0].semantic_metadata = SemanticMetadata(summary="Revenue by region.")
    containers = {"doc": doc, "sheet": table}
    texts = [b.text() for b in doc.blocks]
    item, shipping = texts.index("Print the label"), texts.index("Shipping takes five days.")
    hits = [
        hit("doc", 0.9, item),
        hit("doc", 0.4, shipping),
        hit("doc", 0.7, shipping),  # a sentence point of the same block
        hit("sheet", 0.8, 2),  # south's row
    ]
    units = rank(build_units(hits, containers, UnitSettings()), limit=10)
    assert [(u.kind, u.score) for u in units] == [("list", 0.9), ("table", 0.8), ("block", 0.7)]
    assert units[0].text == "- Pack the item\n- Print the label"
    # Rows found on their own: the summary and only those rows.
    assert units[1].text == "Table\nRevenue by region.\nregion: south, revenue: 95"

    # A hit on the table's own point shows a small table whole.
    whole = build_units([hit("sheet", 0.5, group=0)], containers, UnitSettings())
    assert whole[0].text.endswith(
        "north, revenue: 120\nregion: south, revenue: 95\nregion: east, revenue: 80"
    )
    large = build_units([hit("sheet", 0.5, group=0)], containers, UnitSettings(small_table_cells=4))
    assert large[0].text == "Table\nRevenue by region."

    # Neighbours fill the room the hits left, around the block, never twice.
    around = add_neighbours(units, containers, spare=5)
    assert [u.kind for u in around] == ["list", "table", "block", "neighbour"]
    assert around[3].text == "After shipping." and around[3].neighbour_of == shipping


def test_an_email_found_by_its_header_shows_whole_or_its_opening() -> None:
    email = parse_markdown(b"Parcelforce from Monday.\n\nRates are in the sheet.\n").container
    header = Hit(
        "h", 0.6, {"contentId": "e", "kind": "header", "recordId": "r1", "text": "Subject: Ships"}
    )
    hits = [hit("e", 0.8, 1), header]
    [unit] = build_units(hits, {"e": email}, UnitSettings())
    # The body hit folds into the email it is part of.
    assert (unit.kind, unit.score, unit.record_id, unit.blocks) == ("email", 0.8, "r1", [0, 1])
    assert unit.text == "Subject: Ships\n\nParcelforce from Monday.\nRates are in the sheet."

    [short] = build_units([header], {"e": email}, UnitSettings(email_words=4))
    assert short.blocks == [0] and short.text.endswith("read the record for the rest.]")
