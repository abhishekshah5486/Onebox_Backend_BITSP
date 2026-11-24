"""The dates an upload states for itself, read from labelled lines at its top: an email's
Date: or Sent:, a memo's or meeting header's Date:, front matter's Created: and Last updated:.
A date the text only mentions (a deadline, the day of an incident) never counts, a label for
another event ("Due date:") never does, and a header that gives the writing two different days
is ambiguous. Further down, only an email thread's later message headers count, as when it
last changed."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from onebox_rag.models.blocks import BlocksContainer, BlockSubType, BlockType, DataFormat
from onebox_rag.models.records import DateOrigin, Record

# How much of a document's opening a header may take up.
HEADER_CHARS = 1500
HEADER_BLOCKS = 8
# A document is not dated after its upload; the slack covers time zones.
AFTER_UPLOAD_SLACK = timedelta(days=1)
# A file last modified a day or more before the day its content says it was written
# contradicts it.
FILE_TIME_SLACK = timedelta(days=1)
_EARLIEST = datetime(1970, 1, 2, tzinfo=UTC)

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}  # fmt: skip
_MONTH = "|".join(sorted(_MONTHS, key=len, reverse=True))
_ORDINAL = r"(?:st|nd|rd|th)?"
# Dates that state their day and year outright; a slashed 03/04/2026 can be read two ways.
_DATE = re.compile(
    r"(?P<iso>(?P<iy>\d{4})-(?P<im>\d{2})-(?P<id>\d{2})"
    r"(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)(?![\d:])"
    rf"|(?P<md>(?P<mdm>{_MONTH})\.?\s+(?P<mdd>\d{{1,2}}){_ORDINAL}(?:,\s*|\s+)(?P<mdy>\d{{4}}))"
    rf"|(?P<dm>(?P<dmd>\d{{1,2}}){_ORDINAL}\s+(?:of\s+)?(?P<dmm>{_MONTH})\b\.?(?:,\s*|\s+)(?P<dmy>\d{{4}}))"
    r"|(?<![\d.])(?P<ymd>(?P<ny>\d{4})(?P<sep>[/.])(?P<nm>\d{1,2})(?P=sep)(?P<nd>\d{1,2}))(?![/.]?\d)"
    r"|(?<![\d.])(?P<dot>(?P<td>\d{1,2})\.(?P<tm>\d{1,2})\.(?P<ty>\d{4}))(?!\.?\d)"
    rf"|(?P<dmy3>(?P<xd>\d{{1,2}})-(?P<xm>{_MONTH})-(?P<xy>\d{{4}}))",
    re.IGNORECASE,
)
# A date that opens a range ("2025-03-01 / 2025-03-05", "May 3 to May 5, 2025") names no one
# day the document was written.
_RANGE_AFTER = re.compile(
    rf"^\s{{0,2}}(?:[/\u2013\u2014\u2012-]|to\b|through\b|thru\b|until\b|till\b)\s{{0,3}}(?:\d|{_MONTH})",
    re.IGNORECASE,
)
# The text between a line's start and the date: an optional bullet, a short label, a colon
# and an optional weekday ("Sent: Tuesday, March 3, 2025").
_LABEL_PREFIX = re.compile(
    r"^\s*(?:[-*•>]\s*)*(?:\*\*|__)?(?P<label>[A-Za-z][A-Za-z /&'.-]{0,40}?)\s*(?:\*\*|__)?\s*:"
    r"\s*(?:\*\*|__)?\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?$",
    re.IGNORECASE,
)
_MESSAGE_HEADER = re.compile(r"^\s*(?:\*\*)?from\s*:", re.IGNORECASE | re.MULTILINE)
_MAX_LABEL_WORDS = 4
_CREATED_WORDS = frozenset({
    "date", "dated", "sent", "created", "published", "posted", "issued", "written",
    "recorded", "meeting", "submitted", "filed", "held",
})  # fmt: skip
_MODIFIED_WORDS = frozenset({"updated", "modified", "revised", "edited", "revision"})
# A label for another event's day: "Due date:", "Effective date:", "Release date:".
_OTHER_EVENT_WORDS = frozenset({
    "due", "deadline", "effective", "expiry", "expires", "expiration", "start", "starts",
    "end", "ends", "launch", "release", "target", "eta", "renewal", "next", "incident",
    "outage", "event", "kickoff", "review", "valid", "until", "close", "closing",
    "delivery", "ship", "birth", "travel", "arrival", "departure", "live", "cutover",
})  # fmt: skip

LabelKind = Literal["created", "modified"]


@dataclass(frozen=True)
class DocumentDates:
    """Midnight UTC of the days a document states it was written and last changed."""

    created: datetime
    modified: datetime


@dataclass(frozen=True)
class _Labelled:
    position: int
    block_index: int
    kind: LabelKind
    day: datetime
    in_header: bool
    in_message: bool


def find_document_dates(
    container: BlocksContainer, *, uploaded_at: datetime | None
) -> DocumentDates | None:
    """The dates the document's header states, or None when it states none or is ambiguous.
    `uploaded_at` bounds them: a header dated after the upload is not believed."""
    found: list[_Labelled] = []
    offset = 0
    position = 0
    for block in container.blocks:
        if not _prose(block.type, block.sub_type, block.format) or not isinstance(block.data, str):
            continue
        text = block.data
        in_header_block = position < HEADER_BLOCKS and offset < HEADER_CHARS
        is_message = bool(_MESSAGE_HEADER.search(text))
        if in_header_block or is_message:
            found += _labelled(text, block.index, offset, in_header_block, is_message)
        offset += len(text) + 1
        position += 1
    found.sort(key=lambda labelled: labelled.position)
    header = [labelled for labelled in found if labelled.in_header]
    if not header:
        return None
    latest = uploaded_at + AFTER_UPLOAD_SLACK if uploaded_at else None
    if latest is not None and any(labelled.day > latest for labelled in header):
        return None
    created = [labelled for labelled in header if labelled.kind == "created"]
    if created and _ambiguous(created):
        return None
    modified_days = [labelled.day for labelled in header if labelled.kind == "modified"]
    created_day = created[0].day if created else min(modified_days)
    thread_days = [
        labelled.day
        for labelled in found
        if labelled.in_message
        and labelled.kind == "created"
        and (latest is None or labelled.day <= latest)
    ]
    return DocumentDates(created_day, max([created_day, *modified_days, *thread_days]))


def _prose(kind: BlockType, sub_type: BlockSubType | None, fmt: DataFormat) -> bool:
    """A text block of prose: not a table row, an image, or a code listing."""
    return kind == BlockType.TEXT and BlockSubType.CODE not in (sub_type, fmt)


def _labelled(
    text: str, block_index: int, offset: int, in_header_block: bool, is_message: bool
) -> list[_Labelled]:
    out = []
    for match in _DATE.finditer(text):
        start = match.start()
        if text.count("```", 0, start) % 2:
            # Quoted output, such as an HTTP response's own Date: header.
            continue
        if _RANGE_AFTER.match(text[match.end() :]):
            continue
        day = _day(match)
        if day is None:
            continue
        position = offset + start
        in_header = in_header_block and position < HEADER_CHARS
        if not (in_header or is_message):
            continue
        kind = _label_kind(text, start)
        if kind is not None:
            out.append(_Labelled(position, block_index, kind, day, in_header, is_message))
    return out


def _day(match: re.Match[str]) -> datetime | None:
    """Midnight UTC of the calendar day the date names."""
    parts: tuple[Any, Any, Any]
    if match["iso"]:
        parts = (match["iy"], match["im"], match["id"])
    elif match["md"]:
        parts = (match["mdy"], _MONTHS[match["mdm"].lower()], match["mdd"])
    elif match["dm"]:
        parts = (match["dmy"], _MONTHS[match["dmm"].lower()], match["dmd"])
    elif match["ymd"]:
        parts = (match["ny"], match["nm"], match["nd"])
    elif match["dot"]:
        parts = (match["ty"], match["tm"], match["td"])
    else:
        parts = (match["xy"], _MONTHS[match["xm"].lower()], match["xd"])
    try:
        day = datetime(int(parts[0]), int(parts[1]), int(parts[2]), tzinfo=UTC)
    except ValueError:
        return None
    return day if day >= _EARLIEST else None


def _label_kind(text: str, start: int) -> LabelKind | None:
    """What the label opening the line up to `start` dates, if it dates the document."""
    line_start = text.rfind("\n", 0, start) + 1
    # Some exports leave line breaks as a literal backslash-n.
    escaped = text.rfind("\\n", line_start, start)
    if escaped >= 0:
        line_start = escaped + 2
    match = _LABEL_PREFIX.match(text[line_start:start])
    if match is None:
        return None
    words = re.findall(r"[a-z]+", match["label"].lower())
    if len(words) > _MAX_LABEL_WORDS or not words or _OTHER_EVENT_WORDS.intersection(words):
        return None
    if _MODIFIED_WORDS.intersection(words):
        return "modified"
    if _CREATED_WORDS.intersection(words):
        return "created"
    return None


def _ambiguous(created: list[_Labelled]) -> bool:
    """The first dated header block names two different days for when it was written."""
    first = created[0].block_index
    return len({labelled.day for labelled in created if labelled.block_index == first}) > 1


def plan_dates(
    record: Record, dates: DocumentDates | None, replace: frozenset[DateOrigin]
) -> dict[str, Any] | None:
    """The record fields that bring an upload in line with the dates its content states;
    `dates` None means the content was read and states none. None when nothing changes."""
    if record.date_origin == DateOrigin.CONTENT:
        kept = record.upload_date_origin or DateOrigin.UPLOAD
        if dates is None or kept not in replace:
            return _revert(record)
        if (record.source_created_at, record.source_modified_at) == (dates.created, dates.modified):
            return None
        return {"source_created_at": dates.created, "source_modified_at": dates.modified}
    if dates is None or record.date_origin not in replace or _contradicted(record, dates):
        return None
    return {
        "source_created_at": dates.created,
        "source_modified_at": dates.modified,
        "date_origin": DateOrigin.CONTENT,
        "upload_created_at": record.source_created_at,
        "upload_modified_at": record.source_modified_at,
        "upload_date_origin": record.date_origin,
    }


def _revert(record: Record) -> dict[str, Any]:
    """Put back what the upload set."""
    return {
        "source_created_at": record.upload_created_at or record.created_at,
        "source_modified_at": record.upload_modified_at or record.created_at,
        "date_origin": record.upload_date_origin or DateOrigin.UPLOAD,
        "upload_created_at": None,
        "upload_modified_at": None,
        "upload_date_origin": None,
    }


def _contradicted(record: Record, dates: DocumentDates) -> bool:
    """A file last modified before the day its content says it was written."""
    if record.date_origin != DateOrigin.LAST_MODIFIED or record.source_modified_at is None:
        return False
    return dates.created > record.source_modified_at + FILE_TIME_SLACK
