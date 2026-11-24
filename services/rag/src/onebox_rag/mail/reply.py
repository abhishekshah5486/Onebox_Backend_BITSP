"""An email's own words: the latest reply, without the quoted history that earlier emails of the
thread already hold, so a long thread isn't indexed again with every reply."""

import sys
import warnings
from dataclasses import dataclass
from functools import cache
from typing import Any

import chardet


@cache
def _quotations() -> Any:
    # talon imports cchardet, which has no build for current Python; chardet has its API.
    sys.modules.setdefault("cchardet", chardet)
    with warnings.catch_warnings():
        # Its regexes use plain-string escapes, which newer Python warns about on import.
        warnings.filterwarnings("ignore", category=SyntaxWarning)
        from talon import quotations
    quotations.register_xpath_extensions()
    return quotations


@dataclass(frozen=True)
class Body:
    data: bytes
    mime_type: str


def latest_reply(html: str | None, text: str) -> Body | None:
    """The reply as HTML when the email has it, else as text. A forward keeps everything: what
    was forwarded is usually in no other email of the user's."""
    quotations = _quotations()
    plain = quotations.extract_from_plain(text) if text.strip() else ""
    forwarded = bool(plain and quotations.RE_FWD.search(plain))
    if html and html.strip():
        body = html if forwarded else _safe(quotations.extract_from_html, html)
        return Body(body.encode(), "text/html")
    if text.strip():
        return Body((plain or text).encode(), "text/plain")
    return None


def _safe(extract: Any, html: str) -> str:
    # talon gives up on some markup; the whole body beats losing the email.
    try:
        reply = str(extract(html))
    except Exception:
        return html
    return reply if reply.strip() else html
