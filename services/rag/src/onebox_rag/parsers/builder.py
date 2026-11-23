import uuid
from typing import Any

from onebox_rag.models.blocks import (
    Block,
    BlockGroup,
    BlockGroupChildren,
    BlocksContainer,
    BlockSubType,
    BlockType,
    CitationMetadata,
    DataFormat,
    GroupType,
)


class BlocksBuilder:
    """Appends blocks and groups in reading order and keeps their positional links right."""

    def __init__(self) -> None:
        self._blocks: list[Block] = []
        self._groups: list[BlockGroup] = []
        # Open headings as (level, text), outermost first.
        self._headings: list[tuple[int, str]] = []

    def heading(self, level: int, text: str) -> None:
        self._headings = [h for h in self._headings if h[0] < level] + [(level, text)]

    def citation(self, **fields: Any) -> CitationMetadata:
        path = [text for _, text in self._headings]
        return CitationMetadata(
            section_title=path[-1] if path else None, heading_path=path, **fields
        )

    def group(self, type: GroupType, parent: BlockGroup | None = None, **fields: Any) -> BlockGroup:
        group = BlockGroup(
            id=str(uuid.uuid4()),
            index=len(self._groups),
            parent_index=parent.index if parent else None,
            type=type,
            **fields,
        )
        self._groups.append(group)
        return group

    def block(
        self,
        type: BlockType,
        data: Any,
        *,
        parent: BlockGroup | None = None,
        sub_type: BlockSubType | None = None,
        format: DataFormat = DataFormat.TXT,
        cite: bool = True,
        **fields: Any,
    ) -> Block:
        if cite and "citation_metadata" not in fields:
            fields["citation_metadata"] = self.citation()
        block = Block(
            id=str(uuid.uuid4()),
            index=len(self._blocks),
            parent_index=parent.index if parent else None,
            type=type,
            sub_type=sub_type,
            format=format,
            data=data,
            **fields,
        )
        self._blocks.append(block)
        return block

    def text(self, text: str, **fields: Any) -> Block | None:
        """A text block, skipped when there is nothing to read."""
        text = text.strip()
        if not text:
            return None
        fields.setdefault("sub_type", BlockSubType.PARAGRAPH)
        return self.block(BlockType.TEXT, text, **fields)

    def extend(self, other: BlocksContainer, parent: BlockGroup | None = None) -> None:
        """Appends another container (an email's body, say), rebasing its indices."""
        block_offset, group_offset = len(self._blocks), len(self._groups)
        for group in other.block_groups:
            group.index += group_offset
            if group.parent_index is not None:
                group.parent_index += group_offset
            elif parent is not None:
                group.parent_index = parent.index
            self._groups.append(group)
        for block in other.blocks:
            block.index += block_offset
            if block.parent_index is not None:
                block.parent_index += group_offset
            elif parent is not None:
                block.parent_index = parent.index
            self._blocks.append(block)

    def build(self) -> BlocksContainer:
        # Children are derived from parent links once, so they can never disagree.
        blocks: dict[int, list[int]] = {}
        groups: dict[int, list[int]] = {}
        for block in self._blocks:
            if block.parent_index is not None:
                blocks.setdefault(block.parent_index, []).append(block.index)
        for group in self._groups:
            if group.parent_index is not None:
                groups.setdefault(group.parent_index, []).append(group.index)
        for group in self._groups:
            group.children = BlockGroupChildren.of(blocks.get(group.index), groups.get(group.index))
        return BlocksContainer(blocks=self._blocks, block_groups=self._groups)
