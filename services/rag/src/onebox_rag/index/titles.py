"""A record's title point, written when the record is made, before its content is parsed: an
email's header (subject, people, date, attachment names), else the record's name. A record is
then found by what it is called or who sent it, which its content rarely says."""

from onebox_rag.models import Record
from onebox_rag.models.records import Address


def _person(address: Address) -> str:
    return f"{address.name} <{address.address}>" if address.name else address.address


# Embedded as given up to this length; a name is a few words, not a document.
MAX_NAME_CHARS = 512


def title_text(record: Record) -> str:
    """What is embedded: the email's header, or the name alone."""
    return header_text(record) if record.mail is not None else record.name[:MAX_NAME_CHARS]


def title_label(record: Record) -> str:
    """What a passage found by its title opens with."""
    return header_text(record) if record.mail is not None else f"Name: {record.name}"


def header_text(record: Record) -> str:
    assert record.mail is not None
    mail = record.mail
    lines = [f"Subject: {record.name}"]
    if mail.sender is not None:
        lines.append(f"From: {_person(mail.sender)}")
    if mail.to:
        lines.append(f"To: {', '.join(map(_person, mail.to))}")
    if mail.cc:
        lines.append(f"CC: {', '.join(map(_person, mail.cc))}")
    if mail.received_at is not None:
        # Spelled out too, so "November" and "Nov" match as words.
        day = mail.received_at
        lines.append(f"Date: {day:%A} {day.day} {day:%B %Y} ({day:%Y-%m-%d})")
    if mail.attachment_names:
        lines.append(f"Attachments: {', '.join(mail.attachment_names)}")
    return "\n".join(lines)
