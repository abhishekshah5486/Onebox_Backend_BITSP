"""One PDF page's regions in reading order, from pdfplumber's words and vectors plus OpenCV on a
raster (columns, tables, pictures, lists, headings)."""

import re
from dataclasses import dataclass, field
from enum import StrEnum
from statistics import median
from typing import Any, Protocol

import cv2
import numpy as np

Box = tuple[float, float, float, float]  # x0, top, x1, bottom in PDF points, origin top left
Word = dict[str, Any]

# Rendering for OpenCV and picture crops.
RASTER_DPI = 100
MAX_IMAGE_EDGE_PX = 1600
# Columns: a gutter sits in the middle 60% of the page, is 8 to 80 points
# wide, and needs enough words to vote on.
COL_MIN_WORDS = 20
COL_BIN = 4.0
COL_GUTTER_MIN, COL_GUTTER_MAX = 8.0, 80.0
COL_CENTRAL = (0.20, 0.80)
COL_MIN_SIDE_LINES = 5
# Pictures: smaller ones are icons and rules; text covering this share of one makes it a
# background or a text frame, not a figure.
IMAGE_MIN_AREA = 4000.0
IMAGE_MAX_WORD_SHARE = 0.2
CAPTION = re.compile(
    r"^\s*(?:fig(?:ure)?s?|chart|graph|exhibit|plate|photo|diagram|illustration|scheme|map)"
    r"\s*\.?\s*[\dIVXivx(]",
    re.IGNORECASE,
)
CAPTION_MAX_GAP = 0.06  # of the page height
# Bullet symbols may touch their text (OCR often reads "\u00b7Item"); dashes, stars, numbers and
# letters need a space after them.
LIST_ITEM = re.compile(
    r"^\s*(?:[\u2022\u00b7\u2023\u2043\u2219\u25aa\u25cf\u25a0\u25c6\u25ba\u2192]\s*"
    r"|(?:[\-\*\u2013\u2014\u2217]|\(\s*\d+\s*\)|\d+[.)]|\(\s*[a-zA-Z]\s*\)|[a-zA-Z][.)]"
    r"|[ivxlcdmIVXLCDM]+[.)])\s+)"
)
ORDERED_ITEM = re.compile(r"^\s*(?:\(\s*\d+\s*\)|\d+[.)])\s+")
UNMAPPED_GLYPH = re.compile(r"\(cid:\d+\)")
# Borderless tables: at least 3 lines of at least 3 aligned cells of up to 6 words, cells split
# by gaps of 1.5 character heights.
ALIGNED_MIN_LINES, ALIGNED_MIN_COLS, ALIGNED_MAX_CELL_WORDS = 3, 3, 6
ALIGNED_GAP = 1.5
ALIGNED_SNAP = 6.0
# Ruled tables OpenCV finds: line kernels of 1/30 of the page, at least a 2 x 2 grid.
RULE_KERNEL_SHARE = 30
RULE_MIN_LINES = 3


class Kind(StrEnum):
    TEXT = "text"
    LIST_ITEM = "list_item"
    TABLE = "table"
    IMAGE = "image"


@dataclass
class Region:
    kind: Kind
    box: Box
    text: str = ""
    size: float = 0.0
    bold: bool = False
    lines: int = 1
    ordered: bool = False
    grid: list[list[str]] | None = None
    image: bytes | None = None
    captions: list[str] = field(default_factory=list)
    side: str = "full"


@dataclass
class Line:
    words: list[Word]
    side: str

    @property
    def box(self) -> Box:
        return _union([_word_box(w) for w in self.words])

    @property
    def text(self) -> str:
        # An unmapped glyph opening a line is its bullet; anywhere else it is dropped.
        return " ".join(
            w["text"] for i, w in enumerate(self.words) if i == 0 or not w.get("unmapped")
        )

    @property
    def size(self) -> float:
        return float(median(w["size"] for w in self.words))

    @property
    def bold(self) -> bool:
        return all("bold" in str(w.get("fontname", "")).lower() for w in self.words)


def _word_box(word: Word) -> Box:
    return (float(word["x0"]), float(word["top"]), float(word["x1"]), float(word["bottom"]))


def _union(boxes: list[Box]) -> Box:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _area(box: Box) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _overlap(a: Box, b: Box) -> float:
    """Share of `a` inside `b`."""
    inter = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    return _area(inter) / _area(a) if _area(a) else 0.0


def _inside(word: Word, boxes: list[Box]) -> bool:
    x, y = (word["x0"] + word["x1"]) / 2, (word["top"] + word["bottom"]) / 2
    return any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes)


def _clean_grid(rows: list[list[str | None]]) -> list[list[str]] | None:
    grid = [[" ".join((cell or "").split()) for cell in row] for row in rows]
    grid = [row for row in grid if any(row)]
    if not grid:
        return None
    width = max(len(row) for row in grid)
    grid = [row + [""] * (width - len(row)) for row in grid]
    keep = [c for c in range(width) if any(row[c] for row in grid)]
    grid = [[row[c] for c in keep] for row in grid]
    return grid if len(grid) >= 2 and len(keep) >= 2 else None


class PageRaster:
    """The page rendered once, on first use, for OpenCV and picture crops (or an image already
    rendered, as OCR has)."""

    def __init__(
        self, pdfium_page: Any, width: float, image: np.ndarray | None = None, dpi: int = RASTER_DPI
    ) -> None:
        self._page, self._width, self._image, self._dpi = pdfium_page, width, image, dpi

    @property
    def image(self) -> np.ndarray:
        if self._image is None:
            bitmap = self._page.render(scale=self._dpi / 72)
            self._image = np.ascontiguousarray(bitmap.to_numpy()[:, :, :3])
        return self._image

    @property
    def scale(self) -> float:
        return float(self.image.shape[1]) / self._width

    def crop_png(self, box: Box) -> bytes | None:
        s = self.scale
        x0, y0 = max(0, int(box[0] * s)), max(0, int(box[1] * s))
        x1, y1 = int(box[2] * s), int(box[3] * s)
        crop = self.image[y0:y1, x0:x1]
        if crop.size == 0:
            return None
        longest = max(crop.shape[:2])
        if longest > MAX_IMAGE_EDGE_PX:
            factor = MAX_IMAGE_EDGE_PX / longest
            crop = cv2.resize(crop, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
        ok, png = cv2.imencode(".png", crop)
        return png.tobytes() if ok else None


def words_of(page: Any) -> list[Word]:
    """The page's words with font and size. Glyphs that map to no character are dropped, except a
    lone one, kept as a possible bullet (fonts often draw bullets with an unmapped glyph)."""
    words = page.extract_words(extra_attrs=["fontname", "size"], use_text_flow=True)
    kept = []
    for word in words:
        text = UNMAPPED_GLYPH.sub("", word["text"]).strip()
        if text:
            kept.append({**word, "text": text})
        elif UNMAPPED_GLYPH.fullmatch(word["text"]):
            kept.append({**word, "text": "\u2022", "unmapped": True})
    return kept


def ruled_tables(raster: PageRaster) -> list[tuple[Box, list[float], list[float]]]:
    """Grids drawn as rules, found on the raster (catches ones pdfplumber's vector edges miss):
    each box with the x and y of its rules in points."""
    gray = cv2.cvtColor(raster.image, cv2.COLOR_RGB2GRAY)
    ink = cv2.adaptiveThreshold(
        255 - gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 15, -2
    )
    height, width = ink.shape
    across = cv2.getStructuringElement(cv2.MORPH_RECT, (max(10, width // RULE_KERNEL_SHARE), 1))
    down = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(10, height // RULE_KERNEL_SHARE)))
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, across)
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, down)
    grid = cv2.bitwise_or(horizontal, vertical)
    contours, _ = cv2.findContours(grid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    s = raster.scale
    found = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < 30 or h < 30:
            continue
        ys = _rule_positions(horizontal[y : y + h, x : x + w].sum(axis=1), w)
        xs = _rule_positions(vertical[y : y + h, x : x + w].sum(axis=0), h)
        if len(ys) < RULE_MIN_LINES or len(xs) < RULE_MIN_LINES:
            continue
        box = (x / s, y / s, (x + w) / s, (y + h) / s)
        found.append((box, [(x + p) / s for p in xs], [(y + p) / s for p in ys]))
    return found


def _rule_positions(profile: np.ndarray, length: int) -> list[float]:
    """Centres of the runs where a rule spans most of the box."""
    on = profile >= 255 * length * 0.5
    positions, start = [], None
    for i, value in enumerate([*on.tolist(), False]):
        if value and start is None:
            start = i
        elif not value and start is not None:
            positions.append((start + i - 1) / 2)
            start = None
    return positions


def tables_on(page: Any, raster: PageRaster | None) -> list[Region]:
    """pdfplumber's ruled tables, then OpenCV's for rules it missed."""
    regions: list[Region] = []
    for table in page.find_tables():
        grid = _clean_grid(table.extract())
        x0, top, x1, bottom = (float(v) for v in table.bbox)
        box: Box = (x0, top, x1, bottom)
        # A frame around the whole page with a column or two is a border, not a table.
        if grid and not (_area(box) > 0.8 * page.width * page.height and len(grid[0]) <= 2):
            regions.append(Region(Kind.TABLE, box, grid=grid))
    if raster is None:
        return regions
    for box, xs, ys in ruled_tables(raster):
        if any(_overlap(box, r.box) > 0.3 or _overlap(r.box, box) > 0.3 for r in regions):
            continue
        settings = {
            "vertical_strategy": "explicit",
            "horizontal_strategy": "explicit",
            "explicit_vertical_lines": xs,
            "explicit_horizontal_lines": ys,
        }
        grid = _clean_grid(page.crop(box, strict=False).extract_table(settings) or [])
        if grid:
            regions.append(Region(Kind.TABLE, box, grid=grid))
    return regions


def images_on(
    page: Any, words: list[Word], raster: PageRaster | None, taken: list[Box]
) -> list[Region]:
    regions: list[Region] = []
    for image in page.images:
        box: Box = (
            max(0.0, float(image["x0"])),
            max(0.0, float(image["top"])),
            min(float(page.width), float(image["x1"])),
            min(float(page.height), float(image["bottom"])),
        )
        if _area(box) < IMAGE_MIN_AREA or any(_overlap(box, t) > 0.5 for t in taken):
            continue
        covered = sum(_area(_word_box(w)) for w in words if _inside(w, [box]))
        if covered > IMAGE_MAX_WORD_SHARE * _area(box):
            continue
        if any(_overlap(box, r.box) > 0.8 for r in regions):
            continue
        data = raster.crop_png(box) if raster is not None else None
        regions.append(Region(Kind.IMAGE, box, image=data))
    return regions


def gutter_of(words: list[Word], width: float) -> float | None:
    """The x of a two-column gutter: a central band almost no word crosses, with enough lines on
    each side. Tables are taken out first, so their column gaps never look like one."""
    if len(words) < COL_MIN_WORDS:
        return None
    bins = np.zeros(int(width // COL_BIN) + 1, dtype=np.int32)
    for word in words:
        bins[int(word["x0"] // COL_BIN) : int(word["x1"] // COL_BIN) + 1] += 1
    # A heading or two may run across the gutter.
    quiet = bins <= max(1, len(words) // 100)
    lo, hi = int(width * COL_CENTRAL[0] // COL_BIN), int(width * COL_CENTRAL[1] // COL_BIN)
    best: tuple[int, int] | None = None
    start = None
    for i in range(lo, hi + 1):
        if quiet[i] and start is None:
            start = i
        if (not quiet[i] or i == hi) and start is not None:
            end = i if quiet[i] else i - 1
            if best is None or end - start > best[1] - best[0]:
                best = (start, end)
            start = None
    if best is None:
        return None
    gap = (best[1] - best[0] + 1) * COL_BIN
    if not COL_GUTTER_MIN <= gap <= COL_GUTTER_MAX:
        return None
    gutter = (best[0] + best[1] + 1) / 2 * COL_BIN
    left = {round(w["top"]) for w in words if w["x1"] <= gutter}
    right = {round(w["top"]) for w in words if w["x0"] >= gutter}
    if min(len(left), len(right)) < COL_MIN_SIDE_LINES:
        return None
    return gutter


def lines_of(words: list[Word], gutter: float | None) -> list[Line]:
    """Words into lines; on a two-column page a line is split at the gutter unless one of its
    words crosses it (a heading over both columns)."""
    rows: list[list[Word]] = []
    for word in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if rows and abs(word["top"] - rows[-1][0]["top"]) <= 0.5 * max(word["size"], 1):
            rows[-1].append(word)
        else:
            rows.append([word])
    lines = []
    for row in rows:
        row.sort(key=lambda w: w["x0"])
        crosses = gutter is not None and any(w["x0"] < gutter < w["x1"] for w in row)
        if gutter is None or crosses:
            lines.append(Line(row, "full"))
            continue
        left = [w for w in row if w["x1"] <= gutter]
        right = [w for w in row if w["x0"] >= gutter]
        lines.extend(Line(part, side) for part, side in ((left, "left"), (right, "right")) if part)
    return lines


def _cells(line: Line) -> list[list[Word]]:
    gap = ALIGNED_GAP * line.size
    cells: list[list[Word]] = [[line.words[0]]]
    for word in line.words[1:]:
        if word["x0"] - cells[-1][-1]["x1"] >= gap:
            cells.append([word])
        else:
            cells[-1].append(word)
    return cells


def aligned_tables(lines: list[Line]) -> tuple[list[Region], set[int]]:
    """Borderless tables: runs of consecutive lines whose cells start at the same x."""
    regions, used = [], set()
    i = 0
    while i < len(lines):
        run = [i]
        starts = [c[0]["x0"] for c in _cells(lines[i])]
        j = i + 1
        while j < len(lines) and len(starts) >= ALIGNED_MIN_COLS and lines[j].side == lines[i].side:
            cells = _cells(lines[j])
            if any(len(c) > ALIGNED_MAX_CELL_WORDS for c in cells) or len(cells) < 2:
                break
            if not all(any(abs(c[0]["x0"] - s) <= ALIGNED_SNAP for s in starts) for c in cells):
                break
            run.append(j)
            j += 1
        first = _cells(lines[i])
        if (
            len(run) >= ALIGNED_MIN_LINES
            and len(starts) >= ALIGNED_MIN_COLS
            and all(len(c) <= ALIGNED_MAX_CELL_WORDS for c in first)
        ):
            grid = []
            for k in run:
                row = [""] * len(starts)
                for cell in _cells(lines[k]):
                    col = min(range(len(starts)), key=lambda c: abs(starts[c] - cell[0]["x0"]))
                    row[col] = (row[col] + " " + " ".join(w["text"] for w in cell)).strip()
                grid.append(row)
            box = _union([lines[k].box for k in run])
            regions.append(Region(Kind.TABLE, box, grid=grid, side=lines[i].side))
            used.update(run)
            i = j
        else:
            i += 1
    return regions, used


def blocks_of(lines: list[Line], rules: list[float], size_change: float = 0.1) -> list[Region]:
    """Lines into paragraphs and list items: a new block at a wide gap, a size or weight change,
    a column change, a horizontal rule, or a bullet."""
    regions: list[Region] = []
    current: list[Line] = []

    def flush() -> None:
        if not current:
            return
        text = " ".join(line.text for line in current)
        item = LIST_ITEM.match(current[0].text)
        regions.append(
            Region(
                Kind.LIST_ITEM if item else Kind.TEXT,
                _union([line.box for line in current]),
                text=LIST_ITEM.sub("", text, count=1) if item else text,
                size=current[0].size,
                bold=all(line.bold for line in current),
                lines=len(current),
                ordered=bool(ORDERED_ITEM.match(current[0].text)),
                side=current[0].side,
            )
        )
        current.clear()

    for line in lines:
        if current:
            prev = current[-1]
            gap = line.box[1] - prev.box[3]
            ruled = any(prev.box[3] <= y <= line.box[1] for y in rules)
            if (
                line.side != prev.side
                or gap > 0.7 * prev.size
                or gap < -prev.size
                or abs(line.size - prev.size) > size_change * prev.size
                or line.bold != prev.bold
                or ruled
                or LIST_ITEM.match(line.text)
            ):
                flush()
        current.append(line)
    flush()
    return regions


def link_captions(regions: list[Region], height: float) -> None:
    """A "Figure 3: ..." line just above or below a picture is its caption (the text stays)."""
    for image in (r for r in regions if r.kind == Kind.IMAGE):
        for text in (r for r in regions if r.kind == Kind.TEXT and CAPTION.match(r.text)):
            gap = min(abs(text.box[1] - image.box[3]), abs(image.box[1] - text.box[3]))
            if gap <= CAPTION_MAX_GAP * height:
                image.captions.append(text.text)


class Placed(Protocol):
    side: str

    @property
    def box(self) -> Box: ...


def reading_order[T: Placed](items: list[T], gutter: float | None) -> list[T]:
    """Top to bottom; on two columns, the left column then the right between full-width items."""
    if gutter is None:
        return sorted(items, key=lambda r: (r.box[1], r.box[0]))
    for item in items:
        if (
            isinstance(item, Region)
            and item.side == "full"
            and item.kind in (Kind.TABLE, Kind.IMAGE)
        ):
            if item.box[2] <= gutter:
                item.side = "left"
            elif item.box[0] >= gutter:
                item.side = "right"
    regions = items
    full: list[T] = sorted((r for r in regions if r.side == "full"), key=lambda r: r.box[1])
    ordered: list[T] = []
    top = float("-inf")
    for stop in [*full, None]:
        bottom = stop.box[1] if stop is not None else float("inf")
        for side in ("left", "right"):
            ordered.extend(
                sorted(
                    (r for r in regions if r.side == side and top <= r.box[1] < bottom),
                    key=lambda r: r.box[1],
                )
            )
        if stop is not None:
            ordered.append(stop)
            top = stop.box[1]
    return ordered


def grid_from_words(words: list[Word], xs: list[float], ys: list[float]) -> list[list[str]] | None:
    """A ruled grid's cells filled with the words whose centres fall in them."""
    xs, ys = sorted(xs), sorted(ys)
    cells: list[list[list[Word]]] = [[[] for _ in xs[1:]] for _ in ys[1:]]
    for word in words:
        x, y = (word["x0"] + word["x1"]) / 2, (word["top"] + word["bottom"]) / 2
        col = next((c for c in range(len(xs) - 1) if xs[c] <= x < xs[c + 1]), None)
        row = next((r for r in range(len(ys) - 1) if ys[r] <= y < ys[r + 1]), None)
        if col is not None and row is not None:
            cells[row][col].append(word)
    rows: list[list[str | None]] = [
        [
            " ".join(w["text"] for w in sorted(cell, key=lambda w: (w["top"], w["x0"])))
            for cell in row
        ]
        for row in cells
    ]
    return _clean_grid(rows)


def arrange(
    words: list[Word],
    width: float,
    height: float,
    placed: list[Region],
    rules: list[float],
    size_change: float = 0.1,
) -> list[Region]:
    """The words outside the tables and pictures already found, as lines, borderless tables and
    blocks, all in reading order."""
    taken = [r.box for r in placed]
    free = [w for w in words if not _inside(w, taken)]
    gutter = gutter_of(free, width)
    lines = lines_of(free, gutter)
    aligned, used = aligned_tables(lines)
    rest = reading_order([line for i, line in enumerate(lines) if i not in used], gutter)
    regions = placed + aligned + blocks_of(rest, rules, size_change)
    link_captions(regions, height)
    return reading_order(regions, gutter)


def page_regions(page: Any, pdfium_page: Any) -> list[Region]:
    words = words_of(page)
    vectors = len(page.lines) + len(page.rects) + len(page.curves)
    needs_raster = vectors >= 4 or bool(page.images)
    raster = PageRaster(pdfium_page, float(page.width)) if needs_raster else None
    tables = tables_on(page, raster)
    images = images_on(page, words, raster, [t.box for t in tables])
    rules = [
        (float(ln["top"]) + float(ln["bottom"])) / 2
        for ln in page.lines
        if abs(float(ln["bottom"]) - float(ln["top"])) < 2
        and float(ln["x1"]) - float(ln["x0"]) >= 0.5 * float(page.width)
    ]
    return arrange(words, float(page.width), float(page.height), tables + images, rules)


def ocr_regions(
    words: list[Word], width: float, height: float, raster: PageRaster, size_change: float
) -> list[Region]:
    """A scanned page: OCR words, with ruled tables found by OpenCV on the same render."""
    tables = []
    for box, xs, ys in ruled_tables(raster):
        grid = grid_from_words(words, xs, ys)
        if grid:
            tables.append(Region(Kind.TABLE, box, grid=grid))
    return arrange(words, width, height, tables, [], size_change)
