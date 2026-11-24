"""SVG drawn as a PNG, so it goes the image path (OCR and description). The SVG comes from a
document, so what it may cost is checked before cairo draws it; the parse worker's deadline
and memory watch cover the drawing itself."""

import os
import re
import sys
from functools import cache
from typing import Any
from xml.etree.ElementTree import Element, TreeBuilder

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from onebox_rag.parsers.base import UnreadableFileError

SVG = "image/svg+xml"
MAX_SVG_BYTES = 5 * 1024 * 1024
MAX_ELEMENTS = 50_000
MAX_DEPTH = 100
# Each <use> or url(#id) draws its target again; this bounds what the drawing expands to.
MAX_EXPANDED_ELEMENTS = 200_000
MAX_REFERENCES = 20_000
MAX_OUTPUT_PIXELS = 32_000_000
# Drawn at this size when the SVG gives none.
DEFAULT_SIZE = (800, 600)

_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK_NS = "http://www.w3.org/1999/xlink"
_SVG_TAG = re.compile(r"<svg\b[^>]*>", re.IGNORECASE)
_CSS_URL_REF = re.compile(r"url\(\s*['\"]?\s*#([^'\")\s]+)")
_CSS_VAR = re.compile(r"var\(\s*--[\w-]+\s*(,)?")
_LENGTH = re.compile(r"^\s*([\d.]+)\s*(px|pt)?\s*$")


class _OverBudget(Exception):
    pass


class _Budget(TreeBuilder):
    """Stops the parse at the first element past the count or depth limit."""

    def __init__(self) -> None:
        super().__init__()
        self.count = self.depth = 0

    def start(self, tag: Any, attrs: Any) -> Element:
        self.count += 1
        self.depth += 1
        if self.count > MAX_ELEMENTS or self.depth > MAX_DEPTH:
            raise _OverBudget
        return super().start(tag, attrs)

    def end(self, tag: Any) -> Element:
        self.depth -= 1
        return super().end(tag)


def svg_to_png(data: bytes) -> bytes:
    if len(data) > MAX_SVG_BYTES:
        raise UnreadableFileError("the SVG is too large to draw")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as err:
        raise UnreadableFileError("the SVG is not UTF-8") from err
    text = with_namespaces(without_css_vars(text))
    root = _parse(text)
    _check_expansion(root)
    width, height = size_of(root)
    if width * height > MAX_OUTPUT_PIXELS:
        raise UnreadableFileError("the SVG would be drawn too large")
    try:
        png: bytes = _cairosvg().svg2png(
            bytestring=text.encode(),
            output_width=width,
            output_height=height,
            # Not unsafe: entities stay off and only data: URIs are loaded, never files or URLs.
            unsafe=False,
        )
    except Exception as err:
        raise UnreadableFileError(f"could not draw the SVG ({type(err).__name__})") from err
    return png


def _parse(text: str) -> Element:
    """Well-formed XML without entities or DTDs (cairosvg couldn't read anything else)."""
    parser = ElementTree.XMLParser(target=_Budget())
    try:
        parser.feed(text.encode())
        root: Element = parser.close()
    except _OverBudget as err:
        raise UnreadableFileError("the SVG is too complex to draw") from err
    except DefusedXmlException as err:
        raise UnreadableFileError("the SVG uses entities or a DTD") from err
    except ElementTree.ParseError as err:
        raise UnreadableFileError("the SVG is not well-formed") from err
    return root


def _references(node: Element) -> list[str]:
    refs = []
    for name, value in node.attrib.items():
        if name.rsplit("}", 1)[-1] == "href" and value.strip().startswith("#"):
            refs.append(value.strip()[1:])
        elif "url(" in value:
            refs.extend(_CSS_URL_REF.findall(value))
    if node.tag.rsplit("}", 1)[-1] == "style" and node.text:
        refs.extend(_CSS_URL_REF.findall(node.text))
    return refs


def _check_expansion(root: Element) -> None:
    """Refuses an SVG whose references draw too much, or draw themselves."""
    ids: dict[str, Element] = {}
    references = 0
    for node in root.iter():
        if node.get("id"):
            ids.setdefault(node.get("id", "").strip(), node)
        references += len(_references(node))
    if references > MAX_REFERENCES:
        raise UnreadableFileError("the SVG has too many references")
    sizes: dict[int, int] = {}

    def expanded(node: Element, active: frozenset[int]) -> int:
        key = id(node)
        if key in sizes:
            return sizes[key]
        if key in active:
            raise UnreadableFileError("the SVG references itself")
        inner = active | {key}
        total = 1 + sum(expanded(child, inner) for child in node)
        total += sum(expanded(ids[ref], inner) for ref in _references(node) if ref in ids)
        if total > MAX_EXPANDED_ELEMENTS:
            raise UnreadableFileError("the SVG expands to too much to draw")
        sizes[key] = total
        return total

    expanded(root, frozenset())


def size_of(root: Element) -> tuple[int, int]:
    """width/height in pixels, else the viewBox's, else the default."""

    def length(name: str) -> int | None:
        match = _LENGTH.match(root.get(name) or "")
        return int(float(match.group(1))) or None if match else None

    width, height = length("width"), length("height")
    box = re.findall(r"[-+]?\d*\.?\d+", root.get("viewBox") or "")
    if len(box) == 4:
        width = width or int(float(box[2])) or None
        height = height or int(float(box[3])) or None
    return width or DEFAULT_SIZE[0], height or DEFAULT_SIZE[1]


def without_css_vars(text: str) -> str:
    """Each `var(--name, fallback)` becomes its fallback, as a browser does with an undefined
    property; cairo can't read var() and misreads the colour inside it. One pass with a stack,
    since the SVG comes from a document."""
    if "var(" not in text:
        return text
    out: list[str] = []
    # Per open var(): has a fallback, parens open inside it, where it starts in text and in out.
    frames: list[list[Any]] = []
    i = 0
    while i < len(text):
        found = _CSS_VAR.match(text, i) if text[i] == "v" else None
        if found:
            fallback = found.group(1) is not None
            frames.append([fallback, 0, i, len(out)])
            i = found.end()
            if fallback:
                while i < len(text) and text[i].isspace():
                    i += 1
            else:
                out.extend(found.group(0))
            continue
        char = text[i]
        if frames and char == "(":
            frames[-1][1] += 1
        elif frames and char == ")":
            if frames[-1][1]:
                frames[-1][1] -= 1
            else:
                fallback, _, _, start = frames.pop()
                if fallback:
                    # What was written since is the fallback; the closing paren goes.
                    while len(out) > start and out[-1].isspace():
                        out.pop()
                    i += 1
                    continue
        out.append(char)
        i += 1
    if frames:  # a var( never closed: left as written from there
        _, _, started, kept = frames[0]
        return "".join(out[:kept]) + text[started:]
    return "".join(out)


def with_namespaces(text: str) -> str:
    """Adds the SVG and xlink namespaces when the file uses them without declaring them."""
    tag = _SVG_TAG.search(text)
    if tag is None:
        return text
    head = tag.group(0)[:-1].rstrip("/")
    closing = tag.group(0)[len(head) :]
    added = head
    if not re.search(r"\bxmlns\s*=", head):
        added += f' xmlns="{_SVG_NS}"'
    if "xlink:" in text and "xmlns:xlink" not in head:
        added += f' xmlns:xlink="{_XLINK_NS}"'
    return text[: tag.start()] + added + closing + text[tag.end() :]


@cache
def _cairosvg() -> Any:
    # On macOS Homebrew's cairo isn't on the default library path; its prefix is looked in too.
    prefix = os.environ.get("HOMEBREW_PREFIX")
    if sys.platform == "darwin" and prefix:
        paths = os.environ.get("DYLD_FALLBACK_LIBRARY_PATH", "").split(os.pathsep)
        os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = os.pathsep.join(
            [p for p in paths if p] + [os.path.join(prefix, "lib")]
        )
    import cairosvg

    return cairosvg
