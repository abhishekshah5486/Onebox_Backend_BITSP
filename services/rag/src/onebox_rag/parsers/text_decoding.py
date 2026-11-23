import codecs

from charset_normalizer import from_bytes

_BOMS = (
    (codecs.BOM_UTF32_LE, "utf-32-le"),
    (codecs.BOM_UTF32_BE, "utf-32-be"),
    (codecs.BOM_UTF8, "utf-8"),
    (codecs.BOM_UTF16_LE, "utf-16-le"),
    (codecs.BOM_UTF16_BE, "utf-16-be"),
)


def decode_text(content: bytes) -> str:
    """Text in any encoding, never raising: byte-order mark, strict UTF-8, the detected
    charset, then Windows-1252 with undecodable bytes replaced."""
    for bom, encoding in _BOMS:
        if content.startswith(bom):
            return content[len(bom) :].decode(encoding, errors="replace")
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        pass
    best = from_bytes(content).best()
    if best is not None:
        return str(best)
    return content.decode("cp1252", errors="replace")
