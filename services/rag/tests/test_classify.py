from typing import Any, cast

import pytest

from onebox_rag.models.records import Classification
from onebox_rag.parsers.csv_parser import parse_csv
from onebox_rag.parsers.markdown import parse_markdown
from onebox_rag.pipeline.classify import (
    ClassifySettings,
    ClassifyStage,
    classification_from,
    prepare_content,
)
from onebox_rag.pipeline.llm import InvalidOutputError, LlmClient


def test_the_model_reads_text_and_table_rows_in_order_up_to_its_budget() -> None:
    doc = parse_markdown(b"# Plan\n\nShip in March.\n\nThen in April.").container
    assert prepare_content(doc, 1000) == ["Plan", "Ship in March.", "Then in April."]
    # Cut at the first block that would pass the budget, never mid-block.
    assert prepare_content(doc, 4) == ["Plan"]
    sheet = parse_csv(b"region,revenue\nnorth,120\n").container
    assert any("north" in part and "120" in part for part in prepare_content(sheet, 1000))


def test_the_answer_is_kept_tidy_and_needs_a_summary() -> None:
    answer = {
        "summary": " Invoice INV-7 from Acme Corp for March 2026. ",
        "category": " ",
        "subcategories": {"level1": "Invoice", "level2": "", "level3": ""},
        "languages": ["English", "English"],
        "topics": ["payment terms", ""],
        "organizations": ["Acme Corp", "ACME CORP", *[f"Org {n}" for n in range(12)]],
    }
    kept = classification_from(answer)
    assert kept is not None
    assert kept.summary == "Invoice INV-7 from Acme Corp for March 2026."
    assert (
        kept.category is None and kept.languages == ["English"] and kept.topics == ["payment terms"]
    )
    assert kept.organizations is not None and len(kept.organizations) == 10
    assert kept.organizations[:2] == ["Acme Corp", "Org 0"]
    assert classification_from({**answer, "summary": ""}) is None
    assert classification_from("not an object") is None


class FakeLlm:
    def __init__(self, structured: Any) -> None:
        self.structured = structured
        self.texts: list[str] = []

    async def json(self, *_: Any, **__: Any) -> Any:
        if isinstance(self.structured, Exception):
            raise self.structured
        return self.structured

    async def text(self, _user: str, messages: list[dict[str, str]], **__: Any) -> str:
        self.texts.append(messages[0]["content"])
        return "Memo about the harbour budget, March 2026."


@pytest.mark.parametrize("structured", [InvalidOutputError("bad"), {"summary": ""}])
async def test_an_answer_that_never_fits_falls_back_to_a_plain_summary(structured: Any) -> None:
    llm = FakeLlm(structured)
    stage = ClassifyStage(
        cast(Any, None),
        cast(Any, None),
        cast(Any, None),
        cast(LlmClient, llm),
        cast(Any, None),
        ClassifySettings(),
    )
    got = await stage._classify("u1", "File name: memo.md\nDocument Content: \nBudget.")
    assert got == Classification(summary="Memo about the harbour budget, March 2026.")
    assert llm.texts[0].startswith("Provide a concise summary") and "Budget." in llm.texts[0]
