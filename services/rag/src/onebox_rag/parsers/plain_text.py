from onebox_rag.models.blocks import BlocksContainer
from onebox_rag.parsers.base import ParseResult
from onebox_rag.parsers.builder import BlocksBuilder
from onebox_rag.parsers.text_decoding import decode_text


def parse_plain_text(data: bytes) -> ParseResult:
    return ParseResult(plain_text_to_blocks(decode_text(data)))


def plain_text_to_blocks(text: str) -> BlocksContainer:
    """Paragraphs split on blank lines, each citing the line it starts on."""
    out = BlocksBuilder()
    paragraph: list[str] = []
    start = 1
    for number, line in enumerate([*text.splitlines(), ""], start=1):
        if line.strip():
            if not paragraph:
                start = number
            paragraph.append(line.rstrip())
        elif paragraph:
            out.text("\n".join(paragraph), citation_metadata=out.citation(line_number=start))
            paragraph = []
    return out.build()
