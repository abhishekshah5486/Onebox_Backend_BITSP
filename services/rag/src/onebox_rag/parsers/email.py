"""An email (.eml): its headers and body as blocks; attachments become their own records."""

from email import policy
from email.message import EmailMessage, Message, MIMEPart
from email.parser import BytesParser

from onebox_rag.models.blocks import BlockSubType, DataFormat, GroupSubType, GroupType
from onebox_rag.parsers.base import ExtractedFile, ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.html import html_to_blocks
from onebox_rag.parsers.plain_text import plain_text_to_blocks

_HEADERS = ("From", "To", "Cc", "Date", "Subject")


def parse_email(data: bytes, mime_type: str = "") -> ParseResult:
    message = BytesParser(policy=policy.default).parsebytes(data)
    if not isinstance(message, EmailMessage):
        message = EmailMessage(policy=policy.default)
    out = BlocksBuilder()
    record = out.group(
        GroupType.TEXT_SECTION, sub_type=GroupSubType.RECORD, name=_header(message, "Subject")
    )

    headers = out.group(GroupType.KEY_VALUE_AREA, parent=record, sub_type=GroupSubType.HEADERS)
    lines = [f"{name}: {value}" for name in _HEADERS if (value := _header(message, name))]
    out.text("\n".join(lines), parent=headers, sub_type=BlockSubType.MESSAGE, cite=False)

    body = out.group(GroupType.TEXT_SECTION, parent=record, sub_type=GroupSubType.CONTENT)
    part = message.get_body(preferencelist=("html", "plain"))
    if part is not None:
        text = _text(part)
        is_html = part.get_content_subtype() == "html"
        container = html_to_blocks(text) if is_html else plain_text_to_blocks(text)
        body.format = DataFormat.HTML if is_html else DataFormat.TXT
        out.extend(container, parent=body)

    return ParseResult(out.build(), attachments=list(_attachments(message)))


def _header(message: EmailMessage, name: str) -> str:
    try:
        return str(message.get(name, "") or "").strip()
    except (ValueError, IndexError):
        # A malformed header is left out rather than failing the whole email.
        return ""


def _text(part: MIMEPart) -> str:
    try:
        return str(part.get_content())
    except (LookupError, ValueError):
        payload = part.get_payload(decode=True)
        return payload.decode("utf-8", errors="replace") if isinstance(payload, bytes) else ""


def _attachments(message: EmailMessage) -> list[ExtractedFile]:
    files = []
    for number, part in enumerate(message.iter_attachments(), start=1):
        if part.get_content_type() == "message/rfc822":
            inner = part.get_payload()
            first = inner[0] if isinstance(inner, list) and inner else None
            payload = first.as_bytes() if isinstance(first, Message) else b""
            name = part.get_filename() or f"attached-message-{number}.eml"
        else:
            raw = part.get_payload(decode=True)
            payload = raw if isinstance(raw, bytes) else b""
            name = part.get_filename() or f"attachment-{number}"
        if payload:
            files.append(ExtractedFile(name=name, mime_type=part.get_content_type(), data=payload))
    return files
