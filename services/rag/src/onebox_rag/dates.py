"""Date bounds on a search: created and modified, each after and before (inclusive)."""

import calendar
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from onebox_rag.errors import ValidationError

_DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Clock skew allowed before an "after" bound counts as in the future.
_FUTURE_GRACE = timedelta(minutes=5)


class BadDateError(ValidationError):
    """A date bound that can't be read, is reversed, or starts in the future."""


@dataclass(frozen=True)
class DateBounds:
    created_after: datetime | None = None
    created_before: datetime | None = None
    modified_after: datetime | None = None
    modified_before: datetime | None = None
    # An upload dated only by when it was uploaded was written then or earlier, so only a
    # lower bound leaves it out (on while uploads take the dates their content states).
    uploads_undated: bool = False

    def admits(self, created: datetime, modified: datetime, *, upload_dated: bool = False) -> bool:
        """Whether a record with these dates is inside the bounds."""
        if upload_dated and self.uploads_undated:
            return not (
                (self.created_after is not None and created < self.created_after)
                or (self.modified_after is not None and modified < self.modified_after)
            )
        return not (
            (self.created_after is not None and created < self.created_after)
            or (self.created_before is not None and created > self.created_before)
            or (self.modified_after is not None and modified < self.modified_after)
            or (self.modified_before is not None and modified > self.modified_before)
        )

    def given(self) -> bool:
        return any(
            v is not None
            for v in (
                self.created_after,
                self.created_before,
                self.modified_after,
                self.modified_before,
            )
        )


def parse_bounds(
    *,
    created_after: str | None = None,
    created_before: str | None = None,
    modified_after: str | None = None,
    modified_before: str | None = None,
    now: datetime | None = None,
) -> DateBounds:
    """`YYYY-MM-DD` is the start of that day (UTC) as a lower bound and its end as an upper
    one, as a person reads "before 31 March"; a datetime must carry its zone."""
    bounds = DateBounds(
        _parse("createdAfter", created_after, upper=False),
        _parse("createdBefore", created_before, upper=True),
        _parse("modifiedAfter", modified_after, upper=False),
        _parse("modifiedBefore", modified_before, upper=True),
    )
    for after, before, name in (
        (bounds.created_after, bounds.created_before, "created"),
        (bounds.modified_after, bounds.modified_before, "modified"),
    ):
        if after is not None and before is not None and after > before:
            raise BadDateError(f"{name}After must be on or before {name}Before")
    latest = (now or datetime.now(UTC)) + _FUTURE_GRACE
    for value, name in (
        (bounds.created_after, "createdAfter"),
        (bounds.modified_after, "modifiedAfter"),
    ):
        if value is not None and value > latest:
            raise BadDateError(f"{name} cannot be in the future")
    return bounds


def _parse(name: str, value: str | None, *, upper: bool) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    if _DATE_ONLY.match(text):
        day = _calendar_day(text, upper=upper)
        if day is None:
            raise BadDateError(f"{name}: {text!r} is not a date")
        return day.replace(hour=23, minute=59, second=59, microsecond=999_000) if upper else day
    try:
        moment = datetime.fromisoformat(text[:-1] + "+00:00" if text[-1] in "Zz" else text)
    except ValueError as err:
        raise BadDateError(
            f"{name}: use YYYY-MM-DD or a datetime with its zone (2026-01-15T08:00:00Z)"
        ) from err
    if moment.tzinfo is None:
        raise BadDateError(f"{name}: {text!r} has no time zone")
    return moment.astimezone(UTC)


def _calendar_day(text: str, *, upper: bool) -> datetime | None:
    """A day past its month's end ("before 2026-02-30" for the end of February) is the
    month's last day as an upper bound and the next month's first as a lower one."""
    year, month, day = (int(part) for part in text.split("-"))
    if not 1 <= month <= 12 or not 1 <= day <= 31 or year < 1:
        return None
    last = calendar.monthrange(year, month)[1]
    first = datetime(year, month, 1, tzinfo=UTC)
    if day <= last:
        return first.replace(day=day)
    return first.replace(day=last) + (timedelta() if upper else timedelta(days=1))
