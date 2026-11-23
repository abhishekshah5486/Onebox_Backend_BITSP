import json
import re
from typing import Any

import httpx

from onebox_rag.models.blocks import BlocksContainer, BlockType, GroupType
from onebox_rag.parsers.csv_parser import parse_csv
from onebox_rag.parsers.markdown import parse_markdown
from onebox_rag.pipeline.llm import LlmClient
from onebox_rag.pipeline.tables import TableEnricher, TableSettings, align_by_key, row_keys

SALES = b"""Region,Sales,Sales,Expenses
,Q1,Q2,Q1
North,120,140,90
South,95,99,70
East,80,85,60
"""
KEY = re.compile(r"^\[([A-Z2-7]{4})\]: (\{.*\})$", re.MULTILINE)


class FakeProxy:
    """Answers like llm-proxy: a header decision and summary, then a sentence per keyed row
    (leaving out any row in `skip`)."""

    def __init__(self, header_rows: int = 2, skip: str = "", status: int = 200) -> None:
        self.header_rows, self.skip, self.status = header_rows, skip, status
        self.calls: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.calls.append(body)
        if self.status != 200:
            return httpx.Response(self.status, json={"code": "OUT_OF_CREDITS"})
        prompt = body["messages"][-1]["content"]
        if body["schema"]["name"] == "table_analysis":
            output: Any = {
                "has_headers": self.header_rows > 0,
                "num_header_rows": self.header_rows,
                "headers": [],
                "summary": "Quarterly sales and expenses by region.",
            }
        else:
            rows = [(key, json.loads(row)) for key, row in KEY.findall(prompt)]
            output = {
                "descriptions": [
                    {"key": key, "description": f"{row['Region']} in sentences."}
                    for key, row in rows
                    if row["Region"] != self.skip
                ]
            }
        return httpx.Response(200, json={"output": output, "model": "fake"})


def enricher(proxy: FakeProxy, max_rows: int = 1000) -> TableEnricher:
    llm = LlmClient("http://llm-proxy", "token", 5, httpx.MockTransport(proxy))
    return TableEnricher(
        llm, TableSettings(max_rows, batch_rows=50, concurrency=2, max_output_tokens=4096)
    )


def rows(container: BlocksContainer) -> list[tuple[bool, str]]:
    return [
        (bool(b.table_row_metadata and b.table_row_metadata.is_header), b.text())
        for b in container.blocks
        if b.type == BlockType.TABLE_ROW
    ]


async def test_decides_header_rows_and_writes_row_sentences() -> None:
    container = parse_csv(SALES).container
    proxy = FakeProxy(header_rows=2, skip="South")
    assert await enricher(proxy).enrich("user-1", container) == 2
    assert container.problems() == []
    assert rows(container) == [
        (True, "Region | Sales | Sales | Expenses"),
        (True, "Q1 | Q2 | Q1"),
        (False, "North in sentences."),
        # Left out by the model: plain text with the decided column names.
        (False, "Region: South, Sales - Q1: 95, Sales - Q2: 99, Expenses - Q1: 70"),
        (False, "East in sentences."),
    ]
    [table] = [g for g in container.block_groups if g.type == GroupType.TABLE]
    assert table.table_metadata is not None
    assert table.table_metadata.column_names == [
        "Region",
        "Sales - Q1",
        "Sales - Q2",
        "Expenses - Q1",
    ]
    assert (table.table_metadata.num_of_rows, table.table_metadata.header_guessed) == (3, False)
    assert table.semantic_metadata is not None
    assert table.semantic_metadata.summary == "Quarterly sales and expenses by region."
    north = next(b for b in container.blocks if b.text() == "North in sentences.")
    assert north.data["plain"].startswith("Region: North, Sales - Q1: 120")
    assert {c["userId"] for c in proxy.calls} == {"user-1"} and all(c["cache"] for c in proxy.calls)


async def test_keeps_known_headers_and_stops_at_the_row_budget() -> None:
    container = parse_markdown(
        b"| Region | Plan |\n|---|---|\n| North | Pro |\n| South | Team |"
    ).container
    proxy = FakeProxy(header_rows=0)
    assert await enricher(proxy, max_rows=1).enrich("user-1", container) == 1
    assert "already known" in proxy.calls[0]["messages"][-1]["content"]
    assert rows(container) == [(False, "North in sentences."), (False, "Region: South, Plan: Team")]


async def test_out_of_credits_leaves_plain_rows() -> None:
    container = parse_csv(SALES).container
    before = rows(container)
    assert await enricher(FakeProxy(status=402)).enrich("user-1", container) == 0
    assert rows(container) == before


def test_matches_descriptions_by_key_not_position() -> None:
    keys = row_keys([{"a": "1"}, {"a": "2"}, {"a": "3"}])
    assert len(set(keys)) == 3
    entries = [
        {"key": f"[{keys[2].lower()}]", "description": "third"},
        {"key": keys[0], "description": "first"},
        {"key": "ZZZZ", "description": "stray"},
    ]
    assert align_by_key(entries, keys) == ["first", None, "third"]
