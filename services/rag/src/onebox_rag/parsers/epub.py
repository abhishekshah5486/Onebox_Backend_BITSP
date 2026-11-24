"""EPUB books: the chapters, in reading order, joined into one HTML document with the book's
pictures inlined, then read like any HTML file.

container.xml names the package (OPF) file; its manifest lists the files and its spine the
reading order. The zip is untrusted: read in memory, in bounded chunks, nothing outside it."""

import base64
import mimetypes
import posixpath
import zipfile
from dataclasses import dataclass, field
from html import escape
from io import BytesIO
from urllib.parse import unquote, urldefrag, urlsplit
from xml.etree.ElementTree import Element

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException
from selectolax.lexbor import LexborHTMLParser, LexborNode

from onebox_rag.parsers.base import ParseResult, ProtectedFileError, UnreadableFileError
from onebox_rag.parsers.html import html_to_blocks
from onebox_rag.parsers.svg import SVG, size_of, svg_to_png
from onebox_rag.parsers.text_decoding import decode_text

EPUB = "application/epub+zip"
MAX_CHAPTER_BYTES = 64 * 1024 * 1024
MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGES_BYTES = 50 * 1024 * 1024
# An illustration bigger than this (4096 x 4096) isn't worth the memory cairo needs to draw it.
MAX_SVG_PIXELS = 16 * 1024 * 1024
_READ_CHUNK = 64 * 1024
_MAX_FALLBACK_HOPS = 8
_CONTAINER = "META-INF/container.xml"
_ENCRYPTION = "META-INF/encryption.xml"
_OPF = "application/oebps-package+xml"
_CHAPTER_TYPES = {"application/xhtml+xml", "text/html", "application/html"}
_RASTER_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
# Font obfuscation, not DRM: only fonts are scrambled, and every reader undoes it.
_FONT_OBFUSCATION = {"http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"}


def parse_epub(data: bytes, mime_type: str = "") -> ParseResult:
    return ParseResult(html_to_blocks(read_epub(data).to_html()))


@dataclass
class Book:
    title: str | None
    language: str | None
    chapters: list[str]

    def to_html(self) -> str:
        lang = f' lang="{escape(self.language)}"' if self.language else ""
        title = f"<title>{escape(self.title)}</title>" if self.title else ""
        body = "".join(f"<section>{chapter}</section>" for chapter in self.chapters)
        head = f'<head><meta charset="utf-8">{title}</head>'
        return f"<!DOCTYPE html><html{lang}>{head}<body>{body}</body></html>"


@dataclass
class _Item:
    path: str
    media_type: str
    fallback: str | None
    properties: frozenset[str] = frozenset()


def _local(tag: object) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _resolve(base: str, href: str) -> str | None:
    """The zip path `href` (relative to the file at `base`) points to; None when it is
    external, empty or would leave the book."""
    href = urldefrag(href.strip()).url
    parts = urlsplit(href)
    if not href or parts.scheme or parts.netloc or href.startswith("/"):
        return None
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(parts.path)))
    return None if path in {".", "", ".."} or path.startswith(("../", "/")) else path


class _Archive:
    def __init__(self, data: bytes) -> None:
        try:
            self._zip = zipfile.ZipFile(BytesIO(data))
        except (zipfile.BadZipFile, OSError, ValueError) as err:
            raise UnreadableFileError("not an EPUB (not a zip archive)") from err
        infos = [i for i in self._zip.infolist() if not i.is_dir()]
        self._infos = {i.filename: i for i in infos}
        self._lower = {name.lower(): name for name in self._infos}
        self.chapter_bytes = 0

    def find(self, path: str) -> zipfile.ZipInfo | None:
        # Books made on case-insensitive file systems often get the case wrong.
        name = path if path in self._infos else self._lower.get(path.lower())
        return self._infos.get(name) if name else None

    def read(self, info: zipfile.ZipInfo) -> bytes:
        """At most the declared size, a chunk at a time: a crafted entry can't inflate past it."""
        if info.flag_bits & 0x1:
            raise ProtectedFileError("the book is password-protected")
        if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise UnreadableFileError("the book uses a compression EPUB doesn't allow")
        chunks, size = [], 0
        try:
            with self._zip.open(info) as handle:
                while chunk := handle.read(_READ_CHUNK):
                    size += len(chunk)
                    if size > info.file_size:
                        raise UnreadableFileError("a file in the book is bigger than it says")
                    chunks.append(chunk)
        except (zipfile.BadZipFile, OSError, EOFError) as err:
            raise UnreadableFileError("the book is damaged") from err
        return b"".join(chunks)

    def package_file(self, path: str) -> Element | None:
        info = self.find(path)
        if info is None:
            return None
        if info.file_size > MAX_PACKAGE_FILE_BYTES:
            raise UnreadableFileError("the book's index files are too large")
        try:
            root: Element = ElementTree.fromstring(self.read(info))
        except (ElementTree.ParseError, DefusedXmlException):
            return None
        return root

    def chapter(self, info: zipfile.ZipInfo) -> bytes:
        self.chapter_bytes += info.file_size
        if self.chapter_bytes > MAX_CHAPTER_BYTES:
            raise UnreadableFileError("the book's chapters are too large")
        return self.read(info)


@dataclass
class _Package:
    title: str | None
    language: str | None
    manifest: dict[str, _Item]
    chapters: list[_Item]


def _package_path(archive: _Archive) -> str:
    root = archive.package_file(_CONTAINER)
    if root is None:
        raise UnreadableFileError("not an EPUB (no readable container.xml)")
    rootfiles = [e for e in root.iter() if _local(e.tag) == "rootfile" and e.get("full-path")]
    # The OPF first, when the container also lists other renditions.
    rootfiles.sort(key=lambda e: (e.get("media-type") or _OPF) != _OPF)
    for rootfile in rootfiles:
        path = _resolve("", rootfile.get("full-path", ""))
        if path:
            return path
    raise UnreadableFileError("not an EPUB (container.xml names no package)")


def _encrypted(archive: _Archive) -> set[str]:
    root = archive.package_file(_ENCRYPTION)
    paths: set[str] = set()
    for entry in [] if root is None else root.iter():
        if _local(entry.tag) != "encrypteddata":
            continue
        method = next(
            (e.get("Algorithm", "") for e in entry.iter() if _local(e.tag) == "encryptionmethod"),
            "",
        )
        if method in _FONT_OBFUSCATION:
            continue
        for ref in entry.iter():
            if _local(ref.tag) == "cipherreference" and ref.get("URI"):
                # Relative to the root of the container.
                path = _resolve("", ref.get("URI", ""))
                if path:
                    paths.add(path.lower())
    return paths


def _texts(elements: list[Element]) -> list[str]:
    return [t for t in (" ".join("".join(e.itertext()).split()) for e in elements) if t]


def _package(archive: _Archive, opf: str) -> _Package:
    root = archive.package_file(opf)
    if root is None or _local(root.tag) != "package":
        raise UnreadableFileError("not an EPUB (no readable package file)")
    sections = {_local(child.tag): child for child in root}
    meta = list(sections["metadata"].iter()) if "metadata" in sections else []
    # EPUB 2 may wrap Dublin Core in <dc-metadata>, so the whole subtree is searched.
    titles = _texts([e for e in meta if _local(e.tag) == "title"])
    languages = _texts([e for e in meta if _local(e.tag) == "language"])
    manifest: dict[str, _Item] = {}
    for entry in sections.get("manifest", []):
        path = _resolve(opf, entry.get("href", "")) if _local(entry.tag) == "item" else None
        if path and entry.get("id"):
            manifest[entry.get("id", "")] = _Item(
                path,
                (entry.get("media-type") or "").strip().lower(),
                entry.get("fallback"),
                frozenset((entry.get("properties") or "").split()),
            )
    spine = [
        ref.get("idref", "")
        for ref in sections.get("spine", [])
        if _local(ref.tag) == "itemref" and ref.get("idref")
    ]
    if not spine:
        # A broken book without a spine still lists its pages in the manifest.
        spine = [key for key, item in manifest.items() if item.media_type in _CHAPTER_TYPES]
    # linear="no" items (notes, answers) stay where the spine puts them: next to their chapters.
    chapters, seen = [], set()
    for item_id in spine:
        item = _chapter_item(manifest, item_id)
        if item is not None and item.path not in seen:
            seen.add(item.path)
            chapters.append(item)
    return _Package(
        titles[0] if titles else None, languages[0] if languages else None, manifest, chapters
    )


def _chapter_item(manifest: dict[str, _Item], item_id: str) -> _Item | None:
    """The XHTML item of a spine entry, following fallbacks; the EPUB 3 navigation document
    is a table of contents, not a chapter."""
    for _ in range(_MAX_FALLBACK_HOPS):
        item = manifest.get(item_id)
        if item is None or "nav" in item.properties:
            return None
        if item.media_type in _CHAPTER_TYPES or (
            not item.media_type and item.path.lower().endswith((".xhtml", ".html", ".htm"))
        ):
            return item
        if not item.fallback:
            return None
        item_id = item.fallback
    return None


@dataclass
class _Images:
    archive: _Archive
    types: dict[str, str]
    encrypted: set[str]
    used_bytes: int = 0
    cache: dict[str, str | None] = field(default_factory=dict)

    def data_uri(self, path: str) -> str | None:
        if path not in self.cache:
            self.cache[path] = self._load(path)
        return self.cache[path]

    def _load(self, path: str) -> str | None:
        info = self.archive.find(path)
        if info is None or path.lower() in self.encrypted or info.flag_bits & 0x1:
            return None
        mime = self.types.get(info.filename) or mimetypes.guess_type(info.filename)[0] or ""
        mime = "image/jpeg" if mime == "image/jpg" else mime
        if mime not in _RASTER_TYPES and mime != SVG:
            return None
        if info.file_size > MAX_IMAGE_BYTES or self.used_bytes + info.file_size > MAX_IMAGES_BYTES:
            return None
        try:
            data = self.archive.read(info)
            if mime == SVG:
                data, mime = self._drawn(data), "image/png"
        except UnreadableFileError:
            return None  # a picture that can't be read is left out, never the book
        if not data or self.used_bytes + len(data) > MAX_IMAGES_BYTES:
            return None
        self.used_bytes += len(data)
        return f"data:{mime};base64,{base64.b64encode(data).decode()}"

    @staticmethod
    def _drawn(svg: bytes) -> bytes:
        try:
            root = ElementTree.fromstring(svg)
        except (ElementTree.ParseError, DefusedXmlException) as err:
            raise UnreadableFileError("unreadable SVG") from err
        width, height = size_of(root)
        if width * height > MAX_SVG_PIXELS:
            raise UnreadableFileError("SVG too large")
        return svg_to_png(svg)


def _chapter(markup: str, path: str, images: _Images) -> tuple[str, bool]:
    """The chapter's body with its pictures inlined, and whether it holds anything."""
    tree = LexborHTMLParser(markup)
    body = tree.body or tree.root
    if body is None:
        return "", False
    # Covers draw their picture as <svg><image href/></svg>, which HTML reading drops.
    for svg in body.css("svg"):
        image = svg.css_first("image")
        href = image and (image.attributes.get("xlink:href") or image.attributes.get("href"))
        if href:
            img = LexborHTMLParser("<img>").css_first("img")
            assert img is not None
            img.attrs["src"] = href
            img.attrs["alt"] = svg.attributes.get("aria-label") or ""
            svg.replace_with(img)
    for img in body.css("img"):
        _inline(img, path, images)
    has_content = bool(body.text(strip=True)) or body.css_first("img") is not None
    return body.inner_html or "", has_content


def _inline(img: LexborNode, path: str, images: _Images) -> None:
    src = (img.attributes.get("src") or "").strip()
    if "srcset" in img.attributes:
        del img.attrs["srcset"]
    if src.startswith("data:"):
        return
    # Pictures outside the book are never fetched; EPUB packages its images inside it.
    target = _resolve(path, src) if src else None
    uri = images.data_uri(target) if target else None
    if uri is None:
        img.decompose()
    else:
        img.attrs["src"] = uri


def read_epub(data: bytes) -> Book:
    archive = _Archive(data)
    opf = _package_path(archive)
    encrypted = _encrypted(archive)
    package = _package(archive, opf)
    if any(item.path.lower() in encrypted for item in package.chapters):
        raise ProtectedFileError("the book is copy-protected")
    types = {}
    for item in package.manifest.values():
        info = archive.find(item.path)
        if info is not None and item.media_type:
            types[info.filename] = item.media_type
    images = _Images(archive, types, encrypted)
    chapters, readable = [], False
    for item in package.chapters:
        info = archive.find(item.path)
        if info is None:
            continue  # listed in the spine, missing from the book
        body, has_content = _chapter(decode_text(archive.chapter(info)), info.filename, images)
        chapters.append(body)
        readable = readable or has_content
    if not readable:
        raise UnreadableFileError("the book has no readable chapters")
    return Book(package.title, package.language, chapters)
