"""HTML to blocks by walking the DOM with selectolax (PipesHub's default HTML backend)."""

from selectolax.lexbor import LexborHTMLParser, LexborNode

from onebox_rag.models.blocks import (
    BlockGroup,
    BlocksContainer,
    BlockSubType,
    BlockType,
    CodeMetadata,
    DataFormat,
    GroupType,
    ImageMetadata,
    ListMetadata,
)
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.tables import add_table
from onebox_rag.parsers.text_decoding import decode_text

# Never content: dropped before the walk.
_NOISE = "script, style, noscript, template, head, svg, iframe, object, canvas, button, form"
_HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
# Elements that start their own block; everything else is inline text.
_BLOCK_TAGS = {
    *_HEADINGS,
    "p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "body",
    "ul", "ol", "li", "dl", "dt", "dd", "table", "pre", "blockquote", "figure", "figcaption",
    "hr", "address", "center", "details", "summary", "fieldset",
}  # fmt: skip


def parse_html(data: bytes) -> ParseResult:
    return ParseResult(html_to_blocks(decode_text(data)))


def _squash(text: str) -> str:
    return " ".join(text.split())


def _is_hidden(node: LexborNode) -> bool:
    style = (node.attributes.get("style") or "").replace(" ", "").lower()
    return (
        "hidden" in node.attributes
        or node.attributes.get("aria-hidden") == "true"
        or "display:none" in style
        or "visibility:hidden" in style
    )


def _owner(node: LexborNode, item: LexborNode) -> bool:
    """Whether a nested list belongs directly to this list item, not to a deeper one."""
    parent = node.parent
    while parent is not None and parent.mem_id != item.mem_id:
        if parent.tag in {"ul", "ol"}:
            return False
        parent = parent.parent
    return parent is not None


class _Walker:
    def __init__(self) -> None:
        self.out = BlocksBuilder()
        self.inline: list[str] = []

    def flush(self, parent: BlockGroup | None, quote: bool) -> None:
        text = _squash(" ".join(self.inline))
        self.inline = []
        self.out.text(text, parent=parent, sub_type=BlockSubType.QUOTE if quote else None)

    def children(self, node: LexborNode, parent: BlockGroup | None, quote: bool) -> None:
        for child in node.iter(include_text=True):
            tag = child.tag
            if tag == "-text":
                self.inline.append(child.text_content or "")
            elif tag == "br":
                self.inline.append("\n")
            elif tag == "img":
                self.flush(parent, quote)
                self.image(child, parent)
            elif tag in _BLOCK_TAGS and not _is_hidden(child):
                self.flush(parent, quote)
                self.element(child, parent, quote)
                self.flush(parent, quote)
            elif tag is not None and not _is_hidden(child) and tag != "-comment":
                if self._has_block(child):
                    self.children(child, parent, quote)
                else:
                    self.inline.append(child.text(separator=" "))

    def _has_block(self, node: LexborNode) -> bool:
        return any(d.tag in _BLOCK_TAGS or d.tag == "img" for d in node.traverse() if d is not node)

    def element(self, node: LexborNode, parent: BlockGroup | None, quote: bool) -> None:
        tag = node.tag or ""
        if tag in _HEADINGS:
            text = _squash(node.text(separator=" "))
            self.out.heading(int(tag[1]), text)
            self.out.text(text, parent=parent, sub_type=BlockSubType.HEADING)
        elif tag in {"ul", "ol"}:
            self.list(node, parent, ordered=tag == "ol")
        elif tag == "table":
            self.table(node, parent)
        elif tag == "pre":
            self.out.block(
                BlockType.CODE,
                node.text(deep=True),
                parent=parent,
                sub_type=BlockSubType.CODE,
                format=DataFormat.CODE,
                code_metadata=CodeMetadata(language=self._language(node)),
            )
        elif tag == "blockquote":
            self.children(node, parent, quote=True)
        elif tag != "hr":
            self.children(node, parent, quote)

    def list(self, node: LexborNode, parent: BlockGroup | None, *, ordered: bool) -> None:
        depth = parent.list_metadata.indent_level + 1 if parent and parent.list_metadata else 0
        group = self.out.group(
            GroupType.ORDERED_LIST if ordered else GroupType.LIST,
            parent=parent,
            list_metadata=ListMetadata(
                list_style="numbered" if ordered else "bullet", indent_level=depth
            ),
        )
        for item in node.iter():
            if item.tag != "li" or _is_hidden(item):
                continue
            nested = [c for c in item.css("ul, ol") if _owner(c, item)]
            # Kept as HTML before being cut out, so the item's own text excludes them.
            nested_html = [(sub.tag == "ol", sub.html or "") for sub in nested]
            for sub in nested:
                sub.decompose()
            self.out.text(
                _squash(item.text(separator=" ")), parent=group, sub_type=BlockSubType.LIST_ITEM
            )
            for sub_ordered, html in nested_html:
                sub_node = LexborHTMLParser(html).css_first("ol" if sub_ordered else "ul")
                if sub_node is not None:
                    self.list(sub_node, group, ordered=sub_ordered)

    def table(self, node: LexborNode, parent: BlockGroup | None) -> None:
        header: list[str] = []
        rows: list[list[str]] = []
        for tr in node.css("tr"):
            cells = [c for c in tr.iter() if c.tag in {"td", "th"}]
            texts = [_squash(c.text(separator=" ")) for c in cells]
            if not header and not rows and cells and all(c.tag == "th" for c in cells):
                header = texts
            elif any(texts):
                rows.append(texts)
        caption = node.css_first("caption")
        add_table(
            self.out,
            header,
            rows,
            parent=parent,
            name=_squash(caption.text()) if caption else None,
            format=DataFormat.HTML,
        )

    def image(self, node: LexborNode, parent: BlockGroup | None) -> None:
        alt = _squash(node.attributes.get("alt") or "")
        src = node.attributes.get("src") or ""
        if not alt and not src.startswith(("http://", "https://", "cid:")):
            return
        self.out.block(
            BlockType.IMAGE,
            None,
            parent=parent,
            # Inline data: URIs are never kept; they are the image, not a link to it.
            links=[src] if src.startswith(("http://", "https://", "cid:")) else None,
            image_metadata=ImageMetadata(alt_text=alt or None),
        )

    @staticmethod
    def _language(node: LexborNode) -> str | None:
        code = node.css_first("code")
        for cls in ((code or node).attributes.get("class") or "").split():
            if cls.startswith("language-"):
                return cls.removeprefix("language-")
        return None


def html_to_blocks(html: str) -> BlocksContainer:
    tree = LexborHTMLParser(html)
    for noise in tree.css(_NOISE):
        noise.decompose()
    root = tree.body or tree.root
    walker = _Walker()
    if root is not None:
        walker.children(root, None, quote=False)
        walker.flush(None, quote=False)
    return walker.out.build()
