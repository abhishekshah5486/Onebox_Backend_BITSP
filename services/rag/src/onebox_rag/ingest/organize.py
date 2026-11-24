"""Where uploaded records sit: collections, folders, names, and the trash."""

import re
from collections.abc import Callable
from datetime import datetime

from onebox_rag.errors import ConflictError, NotFoundError, ValidationError
from onebox_rag.ingest.hub import LEGACY_NAMES, FolderStore, KnowledgeBaseStore, clean_name
from onebox_rag.ingest.ingestor import Ingestor
from onebox_rag.ingest.records import RecordStore
from onebox_rag.models import Record, SourceType
from onebox_rag.models.hub import Folder, KnowledgeBase

# An id that is also a name, as the first uploads used (e.g. "default").
LEGACY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Organizer:
    def __init__(
        self,
        kbs: KnowledgeBaseStore,
        folders: FolderStore,
        records: RecordStore,
        ingestor: Ingestor,
        now: Callable[[], datetime],
    ) -> None:
        self.kbs, self.folders, self._records, self._ingestor, self._now = (
            kbs,
            folders,
            records,
            ingestor,
            now,
        )

    def now(self) -> datetime:
        return self._now()

    async def upload_target(
        self, user_id: str, kb_id: str, folder_id: str | None
    ) -> tuple[KnowledgeBase, Folder | None]:
        kb = await self.kbs.get(user_id, kb_id)
        if kb is None:
            if not LEGACY_ID.match(kb_id):
                raise NotFoundError("Collection not found")
            # Uploading to a collection by name makes it, as uploads did before collections.
            try:
                kb = await self.kbs.create(
                    user_id, LEGACY_NAMES.get(kb_id, kb_id), self._now(), kb_id=kb_id
                )
            except ConflictError:
                kb = await self.kbs.require(user_id, kb_id)
        folder = await self.folders.require(user_id, kb.id, folder_id) if folder_id else None
        return kb, folder

    async def folder_for_path(
        self, user_id: str, kb: KnowledgeBase, base: Folder | None, path: str | None
    ) -> Folder | None:
        """The folder a file of a folder upload goes in: its relative path without the name."""
        if not path:
            return base
        parts = [p for p in re.split(r"[\\/]+", path) if p and p not in {".", ".."}][:-1]
        return await self.folders.ensure_path(user_id, kb.id, base, parts, self._now())

    async def create_folder(
        self, user_id: str, kb_id: str, parent_id: str | None, name: str
    ) -> Folder:
        kb = await self.kbs.require(user_id, kb_id)
        parent = await self.folders.require(user_id, kb.id, parent_id) if parent_id else None
        folder = await self.folders.create(user_id, kb.id, parent, name, self._now())
        await self.kbs.touch(user_id, kb.id, self._now())
        return folder

    async def rename_folder(self, user_id: str, kb_id: str, folder_id: str, name: str) -> Folder:
        folder = await self.folders.require(user_id, kb_id, folder_id)
        return await self.folders.rename(user_id, folder, name, self._now())

    async def delete_folder(self, user_id: str, kb_id: str, folder_id: str) -> int:
        """The folder and those below it go; their files go to the trash (and come back to
        the top of the collection if restored)."""
        folder = await self.folders.require(user_id, kb_id, folder_id)
        below = [f.id for f in await self.folders.subtree(user_id, folder)]
        held = [r.id for r in await self._records.in_folders(user_id, below) if r.parent_id is None]
        if held:
            await self._records.trash(held, self._now())
        await self.folders.delete(below)
        return len(held)

    async def delete_kb(self, user_id: str, kb_id: str) -> None:
        """Everything in it goes for good, the search index included."""
        kb = await self.kbs.require(user_id, kb_id)
        for record_id in await self._records.ids_in_source(user_id, SourceType.UPLOAD, kb.id):
            await self._ingestor.delete(user_id, record_id)
        await self.folders.delete_kb(user_id, kb.id)
        await self.kbs.delete(user_id, kb.id)

    async def _upload(self, user_id: str, record_id: str) -> Record:
        record = await self._records.get(user_id, record_id)
        if record is None:
            raise NotFoundError("Record not found")
        if record.source_type != SourceType.UPLOAD or record.parent_id is not None:
            raise ValidationError("Only uploaded files can be renamed or moved")
        return record

    async def _clash(self, record: Record, folder_id: str | None, name: str) -> None:
        if await self._records.name_taken(
            record.user_id, record.source_id, folder_id, name, record.id
        ):
            where = "this folder" if folder_id else "this collection"
            raise ConflictError(f"A file named '{name}' already exists in {where}")

    async def rename_record(self, user_id: str, record_id: str, name: str) -> Record:
        record = await self._upload(user_id, record_id)
        name = clean_name(name, folder=True)
        await self._clash(record, record.folder_id, name)
        # Its title point carries the name, so it is written again.
        renamed = await self._records.update(record.id, self._now(), name=name, titled=False)
        await self._ingestor.renamed(renamed or record)
        return renamed or record

    async def move_record(
        self, user_id: str, kb_id: str, record_id: str, folder_id: str | None
    ) -> Record:
        record = await self._upload(user_id, record_id)
        if record.source_id != kb_id:
            raise NotFoundError("Record not found")
        if folder_id is not None:
            await self.folders.require(user_id, kb_id, folder_id)
        await self._clash(record, folder_id, record.name)
        moved = await self._records.update(record.id, self._now(), folder_id=folder_id)
        await self._records.set_children(record.id, self._now(), folder_id=folder_id)
        return moved or record

    async def trash(self, user_id: str, record_ids: list[str]) -> list[str]:
        """Moves records (and their attachments) to the trash; returns those that were."""
        found = [
            r
            for r in [await self._records.get(user_id, rid) for rid in dict.fromkeys(record_ids)]
            if r is not None and r.parent_id is None
        ]
        if found:
            await self._records.trash([r.id for r in found], self._now())
        return [r.id for r in found]

    async def restore(self, user_id: str, record_ids: list[str]) -> list[str]:
        """Brings records back; one whose folder went meanwhile comes back to the top."""
        restored = []
        for rid in dict.fromkeys(record_ids):
            record = await self._records.get(user_id, rid, trashed=True)
            if record is None:
                continue
            if record.folder_id and await self.folders.get(user_id, record.folder_id) is None:
                await self._records.update(record.id, self._now(), folder_id=None)
                await self._records.set_children(record.id, self._now(), folder_id=None)
            restored.append(record.id)
        if restored:
            await self._records.trash(restored, None)
        return restored
