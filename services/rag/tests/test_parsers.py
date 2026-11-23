from email.message import EmailMessage

from onebox_rag.models.blocks import BlocksContainer, BlockSubType, BlockType, GroupType
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.csv_parser import parse_csv
from onebox_rag.parsers.email import parse_email
from onebox_rag.parsers.html import parse_html
from onebox_rag.parsers.markdown import parse_markdown
from onebox_rag.parsers.registry import parser_for
from onebox_rag.parsers.structured import parse_json, parse_yaml


def valid(result: ParseResult) -> BlocksContainer:
    assert result.container.problems() == []
    return result.container


def texts(container: BlocksContainer, type: BlockType | None = None) -> list[str]:
    return [b.text() for b in container.blocks if type is None or b.type == type]


def group(container: BlocksContainer, type: GroupType) -> list[str]:
    [found] = [g for g in container.block_groups if g.type == type]
    return [container.blocks[i].text() for i in found.children.block_indices()]


MARKDOWN = b"""# Leave policy

## Annual leave

Staff get **25 days** a year.

- Carry over up to 5 days
- Ask your manager
  1. In writing
  2. Two weeks ahead

| Grade | Days |
| ----- | ---- |
| A     | 25   |
| B     | 28   |

```python
print("hi")
```
"""


def test_markdown_keeps_sections_lists_tables_and_code() -> None:
    doc = valid(parse_markdown(MARKDOWN))
    paragraph = next(b for b in doc.blocks if "25 days" in b.text())
    assert paragraph.citation_metadata is not None
    assert paragraph.citation_metadata.heading_path == ["Leave policy", "Annual leave"]
    assert paragraph.citation_metadata.line_number == 5
    assert group(doc, GroupType.LIST) == ["Carry over up to 5 days", "Ask your manager"]
    assert group(doc, GroupType.ORDERED_LIST) == ["In writing", "Two weeks ahead"]
    rows = [b for b in doc.blocks if b.type == BlockType.TABLE_ROW]
    assert [r.text() for r in rows] == ["Grade: A, Days: 25", "Grade: B, Days: 28"]
    assert [r.citation_metadata.line_number for r in rows if r.citation_metadata] == [14, 15]
    [code] = [b for b in doc.blocks if b.type == BlockType.CODE]
    assert code.code_metadata is not None and code.code_metadata.language == "python"


def test_html_drops_noise_and_keeps_structure() -> None:
    html = b"""<html><head><title>x</title><style>p{}</style></head><body>
      <script>alert(1)</script><div hidden>secret</div>
      <h1>Pricing</h1><p>Plans start <b>cheap</b>.</p>
      <ul><li>Basic<ul><li>One seat</li></ul></li><li>Pro</li></ul>
      <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>$5</td></tr></table>
      <img src="https://cdn.example/chart.png" alt="Growth chart">
    </body></html>"""
    doc = valid(parse_html(html))
    assert "secret" not in " ".join(texts(doc)) and "alert" not in " ".join(texts(doc))
    assert texts(doc, BlockType.TEXT)[:2] == ["Pricing", "Plans start cheap ."]
    lists = [g for g in doc.block_groups if g.type == GroupType.LIST]
    assert [doc.blocks[i].text() for i in lists[0].children.block_indices()] == ["Basic", "Pro"]
    assert [doc.blocks[i].text() for i in lists[1].children.block_indices()] == ["One seat"]
    assert lists[1].parent_index == lists[0].index
    assert texts(doc, BlockType.TABLE_ROW) == ["Plan: Basic, Price: $5"]
    [image] = [b for b in doc.blocks if b.type == BlockType.IMAGE]
    assert image.image_metadata is not None and image.image_metadata.alt_text == "Growth chart"


def test_email_reads_headers_and_body_and_hands_back_attachments() -> None:
    inner = EmailMessage()
    inner["Subject"] = "Forwarded"
    inner.set_content("inner body")
    mail = EmailMessage()
    mail["From"], mail["To"], mail["Subject"] = "a@x.co", "b@y.co", "Invoice"
    mail.set_content("Plain version")
    mail.add_alternative("<p>Please find the <b>invoice</b> attached.</p>", subtype="html")
    mail.add_attachment(b"%PDF-1.7", maintype="application", subtype="pdf", filename="inv.pdf")
    mail.add_attachment(inner)

    result = parse_email(mail.as_bytes())
    doc = valid(result)
    assert texts(doc)[0] == "From: a@x.co\nTo: b@y.co\nSubject: Invoice"
    assert doc.blocks[0].sub_type == BlockSubType.MESSAGE
    assert "Please find the invoice attached." in texts(doc)
    assert [(f.name, f.mime_type) for f in result.attachments] == [
        ("inv.pdf", "application/pdf"),
        ("attached-message-2.eml", "message/rfc822"),
    ]
    assert b"inner body" in result.attachments[1].data


def test_structured_data_becomes_fields_groups_and_tables() -> None:
    data = b'{"name": "Acme", "plan": "pro", "address": {"city": "Pune"},'
    data += b' "invoices": [{"id": 1, "total": 10}, {"id": 2, "total": 12}]}'
    doc = valid(parse_json(data))
    assert texts(doc)[0] == "name: Acme, plan: pro"
    assert "city: Pune" in texts(doc)
    assert texts(doc, BlockType.TABLE_ROW) == ["id: 1, total: 10", "id: 2, total: 12"]
    yaml_doc = valid(parse_yaml(b"a: 1\n---\nb: [x, y]\n"))
    assert texts(yaml_doc) == ["a: 1", "b: x, y"]
    # Not JSON after all: still read, as text.
    assert texts(valid(parse_json(b"{oops, not json"))) == ["{oops, not json"]


def test_csv_rows_name_their_columns_and_lines() -> None:
    data = "name,amount,note\nrent,1200,\ncafé,4.5,oat milk\n".encode("cp1252")
    doc = valid(parse_csv(data))
    rows = [b for b in doc.blocks if b.type == BlockType.TABLE_ROW]
    assert [r.text() for r in rows] == [
        "name: rent, amount: 1200",
        "name: café, amount: 4.5, note: oat milk",
    ]
    assert [r.citation_metadata.line_number for r in rows if r.citation_metadata] == [2, 3]


def test_picks_a_parser_by_type_and_leaves_binary_formats_for_later() -> None:
    assert parser_for("text/plain; charset=utf-8") is parser_for("text/markdown")
    assert parser_for("application/vnd.api+json") is parser_for("application/json")
    assert parser_for("text/x-python") is not None
    assert parser_for("application/pdf") is None
