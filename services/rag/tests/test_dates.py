from datetime import UTC, datetime

import pytest

from onebox_rag.dates import BadDateError, parse_bounds

NOW = datetime(2026, 11, 24, tzinfo=UTC)


def test_reads_days_as_whole_days_and_refuses_unclear_bounds() -> None:
    bounds = parse_bounds(created_after="2026-02-16", created_before="2026-02-30", now=NOW)
    assert bounds.created_after == datetime(2026, 2, 16, tzinfo=UTC)
    # Past the month's end: its last day, to the end of that day.
    assert bounds.created_before == datetime(2026, 2, 28, 23, 59, 59, 999_000, tzinfo=UTC)
    assert parse_bounds(modified_after="2026-02-30", now=NOW).modified_after == datetime(
        2026, 3, 1, tzinfo=UTC
    )
    assert parse_bounds(created_after="2026-11-20T09:30:00+01:00", now=NOW).created_after == (
        datetime(2026, 11, 20, 8, 30, tzinfo=UTC)
    )
    for bad in (
        {"created_after": "2026-11-20T09:30:00"},  # no zone
        {"created_after": "last week"},
        {"created_after": "2026-11-20", "created_before": "2026-11-19"},
        {"modified_after": "2027-01-01"},  # in the future
    ):
        with pytest.raises(BadDateError):
            parse_bounds(**bad, now=NOW)
