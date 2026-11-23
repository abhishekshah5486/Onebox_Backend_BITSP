"""An email's header point: subject, people, date and attachment names, so an email is found by
who sent it or what it is called, which its body rarely says."""

from onebox_rag.models import Record
from onebox_rag.models.records import Address


def _person(address: Address) -> str:
    return f"{address.name} <{address.address}>" if address.name else address.address


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
