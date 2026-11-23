"""Search hits become units, the things a model reads and cites: a block; a list item brings
its whole list; table rows gather under their table (its summary and the matched rows, in
table order); a hit on a table's own point brings the whole table when it is small; a hit on a
record's title (its name, an email's header) brings the record (whole when short, else its
opening), and hits inside what it shows fold into it."""

from collections.abc import Callable, Hashable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from onebox_rag.index.qdrant_store import Hit
from onebox_rag.index.texts import image_text, table_titles
from onebox_rag.models.blocks import Block, BlockGroup, BlocksContainer, BlockType, GroupType

LIST_GROUPS = {GroupType.LIST, GroupType.ORDERED_LIST}


@dataclass
class Unit:
    content_id: str
    kind: str  # "block", "list", "table", "record" or "neighbour"
    block_index: int  # the first block it renders
    score: float
    text: str = ""
    group_index: int | None = None
    # Block indices it renders, and for a neighbour those of the unit it was added for.
    blocks: list[int] = field(default_factory=list)
    neighbour_of: int | None = None
    # The record a unit is about, when not any record holding the content (a title hit).
    record_id: str | None = None


@dataclass(frozen=True)
class UnitSettings:
    # A table hit as a whole is shown whole up to this many cells (about 700 words).
    small_table_cells: int = 250
    # A record found by its title is shown whole up to this many words, else this much of it.
    title_hit_words: int = 700


def build_units(
    hits: Sequence[Hit], containers: Mapping[str, BlocksContainer], settings: UnitSettings
) -> list[Unit]:
    """Units in the order their best hit came, each with its best hit's score."""
    units: dict[Hashable, Unit] = {}
    # Table index -> {row block index: best score}, for rows found on their own.
    rows: dict[tuple[str, int], dict[int, float]] = {}
    for hit in hits:
        content_id = str(hit.payload.get("contentId"))
        container = containers.get(content_id)
        if container is None:
            continue
        block_index, group_index = hit.payload.get("blockIndex"), hit.payload.get("groupIndex")
        if hit.payload.get("kind") == "title":
            key: Hashable = (content_id, "record")
            if key in units:
                _raise(units[key], hit.score)
            else:
                header = str(hit.payload.get("label") or hit.payload.get("text") or "")
                record_id = str(hit.payload.get("recordId") or "") or None
                units[key] = _record_unit(
                    container, content_id, header, record_id, hit.score, settings
                )
            continue
        if block_index is None and isinstance(group_index, int):
            _table_hit(units, rows, container, content_id, group_index, hit.score, settings)
            continue
        if not isinstance(block_index, int) or not 0 <= block_index < len(container.blocks):
            continue
        block = container.blocks[block_index]
        parent = _group(container, block.parent_index)
        if block.type == BlockType.TABLE_ROW and parent is not None:
            key = (content_id, "table", parent.index)
            if key in units:  # the whole table is already shown
                _raise(units[key], hit.score)
            else:
                table_rows = rows.setdefault((content_id, parent.index), {})
                table_rows[block_index] = max(table_rows.get(block_index, 0.0), hit.score)
            continue
        if parent is not None and parent.type in LIST_GROUPS:
            key = (content_id, "list", parent.index)
            if key in units:
                _raise(units[key], hit.score)
            else:
                units[key] = _list_unit(container, content_id, parent, hit.score)
            continue
        key = (content_id, "block", block_index)
        if key in units:
            _raise(units[key], hit.score)
            continue
        text = image_text(block) if block.type == BlockType.IMAGE else block.text()
        if text.strip():
            units[key] = Unit(
                content_id, "block", block_index, hit.score, text, None, [block_index]
            )
    for (content_id, table), found in rows.items():
        container = containers[content_id]
        key = (content_id, "table", table)
        unit = units.get(key)
        if unit is not None and unit.blocks:
            _raise(unit, max(found.values()))
            continue
        new = _table_unit(container, content_id, container.block_groups[table], sorted(found))
        new.score = max([*found.values(), unit.score if unit else 0.0])
        units[key] = new
    return _fold_into_records(list(units.values()))


def rank(units: Iterable[Unit], limit: int, max_per_record: int | None = None) -> list[Unit]:
    """Best first (ties keep their order), at most `max_per_record` from one record."""
    ranked = [u for _, u in sorted(enumerate(units), key=lambda item: (-item[1].score, item[0]))]
    if max_per_record is not None:
        per: dict[str, int] = {}
        kept = []
        for unit in ranked:
            if per.get(unit.content_id, 0) < max_per_record:
                per[unit.content_id] = per.get(unit.content_id, 0) + 1
                kept.append(unit)
        ranked = kept
    return ranked[:limit]


def add_neighbours(
    units: list[Unit], containers: Mapping[str, BlocksContainer], spare: int
) -> list[Unit]:
    """Each unit followed by the text blocks just before and after it (around the whole
    table for a table), only in the room the hits left and never a block already shown."""
    shown = {(u.content_id, i) for u in units for i in u.blocks}
    out: list[Unit] = []
    added = 0
    for unit in units:
        out.append(unit)
        container = containers.get(unit.content_id)
        if container is None or unit.kind in {"list", "record"} or not unit.blocks:
            continue
        first, last = _span(container, unit)
        for index in (first - 1, last + 1):
            if added >= spare or (unit.content_id, index) in shown:
                continue
            if not 0 <= index < len(container.blocks):
                continue
            block = container.blocks[index]
            if block.type != BlockType.TEXT or not block.text().strip():
                continue
            shown.add((unit.content_id, index))
            added += 1
            out.append(
                Unit(
                    unit.content_id,
                    "neighbour",
                    index,
                    unit.score,
                    block.text(),
                    None,
                    [index],
                    neighbour_of=unit.block_index,
                )
            )
    return out


def cut_by_record(
    hits: Sequence[Hit],
    limit: int,
    *,
    per_record: int,
    reserve: int,
    record_of: Callable[[Hit], Hashable],
) -> list[Hit]:
    """`limit` hits spread across records: the best `limit - reserve` with at most
    `per_record` from one record, then the best hit of each record not yet in, then rank
    order. Kept hits stay in rank order."""
    if limit < 1 or len(hits) <= limit:
        return list(hits)
    keys = [record_of(h) for h in hits]
    chosen: set[int] = set()
    per_key: dict[Hashable, int] = {}

    def take(i: int) -> None:
        chosen.add(i)
        per_key[keys[i]] = per_key.get(keys[i], 0) + 1

    for i, key in enumerate(keys):
        if len(chosen) >= limit - reserve:
            break
        if per_key.get(key, 0) < max(per_record, 1):
            take(i)
    for i, key in enumerate(keys):
        if len(chosen) >= limit:
            break
        if key not in per_key:
            take(i)
    for i in range(len(hits)):
        if len(chosen) >= limit:
            break
        if i not in chosen:
            take(i)
    return [hits[i] for i in sorted(chosen)]


def _record_unit(
    container: BlocksContainer,
    content_id: str,
    header: str,
    record_id: str | None,
    score: float,
    settings: UnitSettings,
) -> Unit:
    lines: list[str] = []
    shown: list[int] = []
    words = 0
    for block in container.blocks:
        text = image_text(block) if block.type == BlockType.IMAGE else block.text()
        if not text.strip():
            continue
        parent = _group(container, block.parent_index)
        if parent is not None and parent.type in LIST_GROUPS:
            text = f"- {text}"
        count = len(text.split())
        if words + count > settings.title_hit_words:
            if not shown:  # one long paragraph: its opening words
                lines.append(" ".join(text.split()[: settings.title_hit_words]))
                shown.append(block.index)
            lines.append("[The record continues; read it for the rest.]")
            break
        lines.append(text)
        shown.append(block.index)
        words += count
    body = "\n".join(lines)
    return Unit(
        content_id,
        "record",
        shown[0] if shown else 0,
        score,
        f"{header}\n\n{body}".strip(),
        None,
        shown,
        record_id=record_id,
    )


def _fold_into_records(units: list[Unit]) -> list[Unit]:
    """A hit inside the part of a record its title unit shows is that unit's."""
    shown = {u.content_id: (u, set(u.blocks)) for u in units if u.kind == "record"}
    kept = []
    for unit in units:
        email = shown.get(unit.content_id)
        if unit.kind != "record" and email and unit.blocks and set(unit.blocks) <= email[1]:
            _raise(email[0], unit.score)
            continue
        kept.append(unit)
    return kept


def _table_hit(
    units: dict[Hashable, Unit],
    rows: dict[tuple[str, int], dict[int, float]],
    container: BlocksContainer,
    content_id: str,
    group_index: int,
    score: float,
    settings: UnitSettings,
) -> None:
    group = _group(container, group_index)
    if group is None or group.type != GroupType.TABLE:
        return
    key = (content_id, "table", group_index)
    if key in units:
        _raise(units[key], score)
        return
    meta = group.table_metadata
    cells = (meta.num_of_rows or 0) * (meta.num_of_cols or 0) if meta else 0
    if meta is not None and 0 < cells <= settings.small_table_cells:
        unit = _table_unit(container, content_id, group, _rows_of(container, group))
        # Rows found before it lend it their score.
        found = rows.pop((content_id, group_index), {})
        unit.score = max([score, *found.values()])
        units[key] = unit
        return
    # A large table: its summary, with whichever of its rows were found.
    rows.setdefault((content_id, group_index), {})
    units[key] = Unit(content_id, "table", _first(container, group), score, "", group_index)


def _table_unit(
    container: BlocksContainer, content_id: str, group: BlockGroup, row_indices: list[int]
) -> Unit:
    title = table_titles(container.blocks, [group]).get(group.index)
    summary = group.semantic_metadata.summary if group.semantic_metadata else None
    lines = [f"Table: {title}" if title else "Table"]
    if summary:
        lines.append(summary)
    lines += [container.blocks[i].text() for i in row_indices if container.blocks[i].text()]
    return Unit(
        content_id,
        "table",
        row_indices[0] if row_indices else _first(container, group),
        0.0,
        "\n".join(lines),
        group.index,
        row_indices,
    )


def _list_unit(
    container: BlocksContainer, content_id: str, group: BlockGroup, score: float
) -> Unit:
    items = [i for i in group.children.block_indices() if container.blocks[i].text().strip()]
    ordered = group.type == GroupType.ORDERED_LIST
    lines = [
        f"{n}. {container.blocks[i].text()}" if ordered else f"- {container.blocks[i].text()}"
        for n, i in enumerate(items, start=1)
    ]
    first = items[0] if items else _first(container, group)
    return Unit(content_id, "list", first, score, "\n".join(lines), group.index, items)


def _rows_of(container: BlocksContainer, group: BlockGroup) -> list[int]:
    return [
        i
        for i in group.children.block_indices()
        if container.blocks[i].type == BlockType.TABLE_ROW and not _is_header(container.blocks[i])
    ]


def _is_header(block: Block) -> bool:
    return bool(block.table_row_metadata and block.table_row_metadata.is_header)


def _span(container: BlocksContainer, unit: Unit) -> tuple[int, int]:
    if unit.kind == "table" and unit.group_index is not None:
        children = container.block_groups[unit.group_index].children.block_indices()
        if children:
            return min(children), max(children)
    return min(unit.blocks), max(unit.blocks)


def _first(container: BlocksContainer, group: BlockGroup) -> int:
    children = group.children.block_indices()
    return children[0] if children else 0


def _group(container: BlocksContainer, index: int | None) -> BlockGroup | None:
    if index is None or not 0 <= index < len(container.block_groups):
        return None
    return container.block_groups[index]


def _raise(unit: Unit, score: float) -> None:
    unit.score = max(unit.score, score)
