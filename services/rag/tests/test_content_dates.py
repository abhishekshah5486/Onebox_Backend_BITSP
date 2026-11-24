from datetime import UTC, datetime

from onebox_rag.dates import DateBounds
from onebox_rag.ingest.content_dates import DocumentDates, find_document_dates, plan_dates
from onebox_rag.models.records import DateOrigin, Record, SourceType
from onebox_rag.parsers.markdown import parse_markdown

UPLOADED = datetime(2026, 11, 20, tzinfo=UTC)


def day(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, d, tzinfo=UTC)


def dates(markdown: str, uploaded: datetime | None = UPLOADED) -> DocumentDates | None:
    container = parse_markdown(markdown.encode()).container
    return find_document_dates(container, uploaded_at=uploaded)


def test_a_labelled_line_at_the_top_dates_the_document() -> None:
    assert dates("**Date:** March 3, 2025\n\nTo the board.") == DocumentDates(
        day(2025, 3, 3), day(2025, 3, 3)
    )
    assert dates("Sent: Tuesday, 4th of March 2025\n\nHi all.") == DocumentDates(
        day(2025, 3, 4), day(2025, 3, 4)
    )
    assert dates(
        "Created: 2025-01-10\n\nLast updated: 20.02.2025\n\nPolicy text."
    ) == DocumentDates(day(2025, 1, 10), day(2025, 2, 20))


def test_dates_that_say_nothing_of_when_it_was_written_dont_count() -> None:
    for text in (
        "Due date: 2025-04-01\n\nPay by then.",  # another event's day
        "The outage on 2025-03-03 lasted an hour.",  # mentioned, not a label
        "Date: 2025-03-01 / 2025-03-05\n\nWorkshop.",  # a range
        "Date: 03/04/2025\n\nRead either way.",  # day or month first?
        "```\nDate: 2025-03-03\n```",  # quoted output
        "Date: 2027-01-01\n\nFrom the future.",  # after its upload
    ):
        assert dates(text) is None, text
    # Only the opening counts.
    filler = "\n\n".join(f"Paragraph {n}." for n in range(9))
    assert dates(f"{filler}\n\nDate: 2025-03-03") is None


def test_a_header_giving_two_days_is_ambiguous_and_a_thread_moves_its_last_change() -> None:
    assert dates("Date: 2025-03-01\nSent: 2025-03-04\n\nMinutes.") is None
    thread = (
        "Date: 2025-03-01\n\nFirst message.\n\n"
        + "\n\n".join(f"Reply {n}." for n in range(9))
        + "\n\nFrom: Ana\nSent: 2025-03-09\n\nLatest reply."
    )
    assert dates(thread) == DocumentDates(day(2025, 3, 1), day(2025, 3, 9))


def record(origin: DateOrigin, created: datetime = UPLOADED) -> Record:
    return Record.model_validate(
        {
            "_id": "r1",
            "userId": "u1",
            "sourceType": SourceType.UPLOAD,
            "sourceId": "kb",
            "externalId": "x",
            "contentId": "c1",
            "name": "letter.md",
            "mimeType": "text/markdown",
            "declaredMimeType": None,
            "sizeBytes": 1,
            "sha256": "0" * 64,
            "status": "completed",
            "createdAt": UPLOADED,
            "updatedAt": UPLOADED,
            "sourceCreatedAt": created,
            "sourceModifiedAt": created,
            "dateOrigin": origin,
        }
    )


def test_stated_dates_replace_only_what_the_setting_allows_and_can_be_put_back() -> None:
    stated = DocumentDates(day(2025, 3, 3), day(2025, 3, 3))
    only_upload = frozenset({DateOrigin.UPLOAD})
    both = frozenset({DateOrigin.UPLOAD, DateOrigin.LAST_MODIFIED})

    change = plan_dates(record(DateOrigin.UPLOAD), stated, only_upload)
    assert change is not None and change["date_origin"] == DateOrigin.CONTENT
    assert change["upload_created_at"] == UPLOADED and change["source_created_at"] == day(
        2025, 3, 3
    )
    assert (
        plan_dates(record(DateOrigin.LAST_MODIFIED, day(2025, 6, 1)), stated, only_upload) is None
    )
    assert plan_dates(record(DateOrigin.LAST_MODIFIED, day(2025, 6, 1)), stated, both) is not None
    # A file last changed before the day it says it was written contradicts it.
    assert plan_dates(record(DateOrigin.LAST_MODIFIED, day(2025, 1, 1)), stated, both) is None
    assert plan_dates(record(DateOrigin.SOURCE), stated, both) is None

    dated = record(DateOrigin.CONTENT, day(2025, 3, 3)).model_copy(
        update={"upload_created_at": UPLOADED, "upload_date_origin": DateOrigin.UPLOAD}
    )
    revert = plan_dates(dated, None, only_upload)
    assert revert is not None and revert["date_origin"] == DateOrigin.UPLOAD
    assert revert["source_created_at"] == UPLOADED


def test_an_upload_dated_by_its_upload_is_left_out_only_by_a_lower_bound() -> None:

    march = DateBounds(day(2025, 3, 1), day(2025, 3, 31), uploads_undated=True)
    assert march.admits(UPLOADED, UPLOADED, upload_dated=True)
    assert not march.admits(UPLOADED, UPLOADED)
    assert not march.admits(day(2025, 2, 1), day(2025, 2, 1), upload_dated=True)
    assert not DateBounds(created_before=day(2025, 3, 31)).admits(
        UPLOADED, UPLOADED, upload_dated=True
    )
