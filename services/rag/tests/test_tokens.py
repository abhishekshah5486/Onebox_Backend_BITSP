import pytest

from onebox_rag.index import tokens
from onebox_rag.index.points import PointKind, SplitSettings, point_texts
from onebox_rag.index.tokens import TokenLimitError, TokenWindow
from onebox_rag.models.blocks import SemanticMetadata
from onebox_rag.parsers.csv_parser import parse_csv
from onebox_rag.parsers.markdown import parse_markdown

# About 3 cl100k tokens per character, against about 0.25 for English.
CJK = "東京都の出荷規則では返品は三十日以内とする。" * 40
EMOJI = "🚢📦✅ " * 120


def test_text_over_the_window_is_cut_into_pieces_that_fit_and_join_back() -> None:
    window = TokenWindow(limit=128)
    assert window.split("short English text") == ["short English text"]
    for text in (CJK, EMOJI):
        pieces = window.split(text)
        assert len(pieces) > 1 and "".join(pieces) == text
        assert all(window.count(p) <= 128 for p in pieces) and "�" not in "".join(pieces)
    # Another tokenizer may count more: its pieces are smaller by the ratio.
    assert len(TokenWindow(128, ratio=2.13).split(CJK)) > len(window.split(CJK))


def test_without_the_vocabulary_a_byte_counts_as_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tokens, "_encoder", lambda: None)
    pieces = TokenWindow(limit=64).split(CJK)
    assert "".join(pieces) == CJK and all(len(p.encode()) + 2 <= 64 for p in pieces)


def test_a_model_reading_almost_nothing_is_refused() -> None:
    with pytest.raises(TokenLimitError, match="reads only 10 tokens"):
        TokenWindow(limit=10)


def test_the_window_follows_the_model_and_the_ceiling() -> None:
    split = SplitSettings(token_ceiling=8191, token_ratio=2.13)
    assert split.window_for("openai/text-embedding-3-small", 8191) == TokenWindow(8191, 1.0)
    assert split.window_for("ollama/all-minilm", 512) == TokenWindow(512, 2.13)
    assert split.window_for("ollama/bge-m3", None) == TokenWindow(8191, 2.13)
    assert split.window_for("ollama/nomic-embed-text", 32_768) == TokenWindow(8191, 2.13)


def test_every_point_fits_the_model_none_is_cut_off() -> None:
    window = TokenWindow(limit=256)
    block = point_texts(parse_markdown(CJK.encode()).container, SplitSettings(), window)
    assert len(block) > 1 and {p.kind for p in block} == {PointKind.WINDOW}
    assert {p.block_index for p in block} == {0} and "".join(p.text for p in block) == CJK

    # A table summary longer than a block may be is windowed, not cut at the limit.
    sheet = parse_csv(b"region,revenue\nnorth,120\n").container
    sheet.block_groups[0].semantic_metadata = SemanticMetadata(summary="Rates by region. " * 700)
    points = point_texts(sheet, SplitSettings(), window)
    table = [p for p in points if p.kind == PointKind.TABLE]
    assert len(table) > 1 and table[-1].text.rstrip().endswith("Rates by region.")
    assert all(window.fits(p.text) for p in block + points)
    # Pieces with the same text on the same block are one point (same text, same vector).
    distinct = {(p.block_index, p.group_index, p.kind, p.text) for p in block + points}
    assert len({p.point_id("c1", 1) for p in block + points}) == len(distinct)
