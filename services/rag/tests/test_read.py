from onebox_rag.parsers.markdown import parse_markdown
from onebox_rag.retrieval.read import FocusSettings, focused_read

# 40 paragraphs of about 50 characters; the indemnity clause is far from the start.
PARAS = [f"Paragraph {n} says nothing much about anything here." for n in range(40)]
PARAS[30] = "Indemnity: the supplier covers losses up to 1M EUR."
DOC = parse_markdown("\n\n".join(PARAS).encode()).container


def test_short_records_come_whole_and_long_ones_give_the_part_asked_for() -> None:
    whole = focused_read(DOC, [30], FocusSettings(max_chars=100_000))
    assert whole is not None and len(whole["blocks"]) == 40 and whole["gaps"] == []

    part = focused_read(DOC, [30], FocusSettings(max_chars=700, opening_share=0.1))
    assert part is not None
    shown = [b["index"] for b in part["blocks"]]
    # The opening, then the match with its neighbours grown outward, in record order.
    assert shown[0] == 0 and {29, 30, 31} <= set(shown)
    assert any("Indemnity" in b["text"] for b in part["blocks"])
    # What lies between is named as left out.
    assert part["gaps"] and part["gaps"][0]["from"] > 0 and part["gaps"][0]["to"] < 29
    assert sum(len(b["text"]) + 12 for b in part["blocks"]) <= 700

    # No match fits: no opinion, the caller reads in order.
    assert focused_read(DOC, [30], FocusSettings(max_chars=80, opening_share=0.1)) is None
