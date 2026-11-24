from typing import Any
from urllib.parse import parse_qs, urlsplit

import certifi
from pymongo import AsyncMongoClient


def uses_tls(uri: str) -> bool:
    """SRV addresses (Atlas) use TLS unless told not to; plain ones only when asked."""
    parts = urlsplit(uri)
    query = {k.lower(): v[-1].lower() for k, v in parse_qs(parts.query).items()}
    asked = query.get("tls", query.get("ssl"))
    if asked is not None:
        return asked == "true"
    return parts.scheme == "mongodb+srv"


def mongo_client(uri: str, **options: Any) -> AsyncMongoClient[dict[str, Any]]:
    # Trust certifi's CA bundle: some Python installs ship none, and Atlas then fails TLS.
    if uses_tls(uri):
        options.setdefault("tlsCAFile", certifi.where())
    # Dates come back in UTC as written, not as naive times that lose their zone.
    options.setdefault("tz_aware", True)
    return AsyncMongoClient(uri, **options)
