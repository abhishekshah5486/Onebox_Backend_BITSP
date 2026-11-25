"""The knowledge hub: collections and mailboxes at the top, their folders and records below,
browsed a level at a time or searched through everything under a node (flattened)."""

import base64
import binascii
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from onebox_rag.dates import DateBounds
from onebox_rag.errors import NotFoundError, ValidationError
from onebox_rag.ingest.hub import FolderStore, KnowledgeBaseStore
from onebox_rag.ingest.records import RecordFilter, RecordSort, RecordStore
from onebox_rag.models import Record, SourceType, Status
from onebox_rag.models.hub import Folder, KnowledgeBase

NODE_TYPES = ("collection", "mailbox", "folder", "record")
SORTS: dict[str, RecordSort] = {
    "name": "name",
    "createdAt": "createdAt",
    "updatedAt": "updatedAt",
    "size": "sizeBytes",
}
STATUS_LABELS = {
    Status.QUEUED: "Queued",
    Status.IN_PROGRESS: "In Progress",
    Status.COMPLETED: "Completed",
    Status.EMPTY: "Empty",
    Status.FILE_TYPE_NOT_SUPPORTED: "File Type Not Supported",
    Status.PASSWORD_PROTECTED: "Password Protected",
    Status.FAILED: "Failed",
}


def ms(moment: datetime | None) -> int | None:
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return int(moment.timestamp() * 1000)


def _range(value: str | None, name: str) -> tuple[int | None, int | None]:
    """`gte:X,lte:Y` (either part optional), as the hub's date and size filters take them."""
    if not value:
        return None, None
    bounds: dict[str, int] = {}
    for part in value.split(","):
        key, _, number = part.partition(":")
        if key not in {"gte", "lte"} or not number.lstrip("-").isdigit():
            raise ValidationError(f"{name} takes gte:X,lte:Y")
        bounds[key] = int(number)
    return bounds.get("gte"), bounds.get("lte")


def _moment(epoch_ms: int | None) -> datetime | None:
    return None if epoch_ms is None else datetime.fromtimestamp(epoch_ms / 1000, UTC)


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError) as err:
        raise ValidationError("That page token is not valid") from err
    kind, _, offset = raw.partition(":")
    if kind != "o" or not offset.isdigit():
        raise ValidationError("That page token is not valid")
    return int(offset)


@dataclass
class HubQuery:
    q: str | None = None
    record_types: list[str] | None = None
    statuses: list[str] | None = None
    source_ids: list[str] | None = None
    created_at: str | None = None
    updated_at: str | None = None
    size: str | None = None
    sort_by: str = "updatedAt"
    sort_order: str = "desc"
    limit: int = 50
    cursor: str | None = None
    flattened: bool | None = None
    include: set[str] = field(default_factory=set)

    def filtering(self) -> bool:
        return any(
            (
                self.q,
                self.record_types,
                self.statuses,
                self.source_ids,
                self.created_at,
                self.updated_at,
                self.size,
            )
        )

    def record_filter(self, **scope: Any) -> RecordFilter:
        created, updated = (
            _range(self.created_at, "createdAt"),
            _range(self.updated_at, "updatedAt"),
        )
        low, high = _range(self.size, "size")
        dates = DateBounds(
            _moment(created[0]), _moment(created[1]), _moment(updated[0]), _moment(updated[1])
        )
        statuses = [s.lower() for s in self.statuses] if self.statuses else None
        return RecordFilter(
            name=self.q.strip() if self.q else None,
            statuses=statuses,
            record_types=scope.pop("record_types", self.record_types),
            min_size=low,
            max_size=high,
            dates=dates if any([*created, *updated]) else None,
            **scope,
        )


class HubLister:
    def __init__(self, kbs: KnowledgeBaseStore, folders: FolderStore, records: RecordStore) -> None:
        self._kbs, self._folders, self._records = kbs, folders, records

    async def nodes(
        self,
        user_id: str,
        query: HubQuery,
        parent_type: str | None = None,
        parent_id: str | None = None,
    ) -> dict[str, Any]:
        offset = decode_cursor(query.cursor)
        sort = SORTS.get(query.sort_by)
        if sort is None:
            raise ValidationError(f"sortBy is one of {', '.join(SORTS)}")
        descending = query.sort_order == "desc"
        flat = query.flattened if query.flattened is not None else query.filtering()
        current: dict[str, Any] | None = None
        crumbs: list[dict[str, Any]] = []
        containers: list[dict[str, Any]] = []
        scope: dict[str, Any] = {}

        if parent_type is None:
            if flat:
                scope = {"source_ids": query.source_ids}
                # Everything, with attachments under their emails until it is searched.
                if not (query.q or query.record_types or query.statuses):
                    scope["top_level"] = True
            else:
                containers = await self._roots(user_id)
                containers = _sorted(containers, query.sort_by, descending)
                scope = {}
        elif parent_type == "collection":
            kb = await self._kbs.require(user_id, parent_id or "")
            current = _kb_node(kb)
            crumbs = [_crumb(current)]
            scope = {"source_types": [SourceType.UPLOAD], "source_ids": [kb.id]}
            if not flat:
                containers = [
                    _folder_node(f) for f in await self._folders.children(user_id, kb.id, None)
                ]
                scope["folder_ids"] = [None]
                scope["record_types"] = None
        elif parent_type == "folder":
            folder = await self._folders.get(user_id, parent_id or "")
            if folder is None:
                raise NotFoundError("Folder not found")
            kb = await self._kbs.require(user_id, folder.kb_id)
            path = await self._folders.path(user_id, folder)
            current = _folder_node(folder)
            crumbs = [_crumb(_kb_node(kb)), *(_crumb(_folder_node(f)) for f in path)]
            scope = {"source_types": [SourceType.UPLOAD], "source_ids": [kb.id]}
            if flat:
                scope["folder_ids"] = [f.id for f in await self._folders.subtree(user_id, folder)]
            else:
                containers = [
                    _folder_node(f) for f in await self._folders.children(user_id, kb.id, folder.id)
                ]
                scope["folder_ids"] = [folder.id]
        elif parent_type == "mailbox":
            current = _mailbox_node(parent_id or "", None)
            crumbs = [_crumb(current)]
            scope = {"source_types": [SourceType.MAIL], "source_ids": [parent_id]}
            if not flat:
                scope["record_types"] = ["MAIL"]
        elif parent_type == "record":
            record = await self._records.get(user_id, parent_id or "")
            if record is None:
                raise NotFoundError("Record not found")
            children = [
                r for r in await self._records.children(user_id, record.id) if r.deleted_at is None
            ]
            current = _record_node(record, attachments=len(children))
            crumbs = [_crumb(current)]
            items = [_record_node(r) for r in children]
            return self._response(current, crumbs, items, len(items), 0, len(items) or 1, query)
        else:
            raise ValidationError(f"nodeType is one of {', '.join(NODE_TYPES)}")

        if containers and query.q:
            needle = query.q.strip().casefold()
            containers = [c for c in containers if needle in c["name"].casefold()]

        records_wanted = parent_type is not None or flat
        record_types = scope.pop("record_types", query.record_types)
        filters = query.record_filter(
            record_types=record_types, **{k: v for k, v in scope.items() if v is not None}
        )
        # Containers come first, then records, as one list paged together.
        items = containers[offset : offset + query.limit]
        total_records = 0
        if records_wanted:
            room = query.limit - len(items)
            start = max(0, offset - len(containers))
            found, total_records = await self._records.page(
                user_id,
                filters,
                sort=SORTS[query.sort_by],
                descending=descending,
                offset=start,
                limit=max(room, 1),
            )
            emails = [r.id for r in found if r.mail is not None and r.parent_id is None]
            counts = await self._records.child_counts(user_id, emails) if emails else {}
            if room > 0:
                items += [_record_node(r, attachments=counts.get(r.id, 0)) for r in found]
        total = len(containers) + total_records
        return self._response(current, crumbs, items, total, offset, query.limit, query)

    async def _roots(self, user_id: str) -> list[dict[str, Any]]:
        nodes = [_kb_node(kb) for kb in await self._kbs.list(user_id)]
        for source in await self._records.sources(user_id):
            if source["sourceType"] == SourceType.MAIL:
                nodes.append(_mailbox_node(source["sourceId"], source["lastAddedAt"]))
        return nodes

    def _response(
        self,
        current: dict[str, Any] | None,
        crumbs: list[dict[str, Any]],
        items: list[dict[str, Any]],
        total: int,
        offset: int,
        limit: int,
        query: HubQuery,
    ) -> dict[str, Any]:
        end = offset + len(items)
        body: dict[str, Any] = {
            "currentNode": current,
            "items": items,
            "pagination": {
                "limit": limit,
                "totalItems": total,
                "hasNext": end < total,
                "hasPrev": offset > 0,
                "startIndex": offset + 1 if items else 0,
                "endIndex": end,
                "nextCursor": encode_cursor(end) if end < total else None,
                "prevCursor": encode_cursor(max(0, offset - limit)) if offset > 0 else None,
            },
        }
        if "breadcrumbs" in query.include:
            body["breadcrumbs"] = crumbs
        if "counts" in query.include:
            folders = sum(1 for i in items if i["nodeType"] == "folder")
            body["counts"] = {
                "items": [
                    {"label": "folders", "count": folders},
                    {
                        "label": "records",
                        "count": sum(1 for i in items if i["nodeType"] == "record"),
                    },
                ],
                "total": total,
            }
        if "permissions" in query.include:
            editable = current is None or current["nodeType"] in {"collection", "folder"}
            body["permissions"] = {
                "role": "OWNER",
                "canUpload": editable and current is not None,
                "canCreateFolders": editable and current is not None,
                "canEdit": True,
                "canDelete": True,
            }
        return body

    async def available_filters(self, user_id: str) -> dict[str, Any]:
        sources = [
            {"id": kb.id, "label": kb.name, "type": "collection"}
            for kb in await self._kbs.list(user_id)
        ]
        sources += [
            {"id": s["sourceId"], "label": "Mail", "type": "mailbox"}
            for s in await self._records.sources(user_id)
            if s["sourceType"] == SourceType.MAIL
        ]
        return {
            "recordTypes": [{"id": "FILE", "label": "File"}, {"id": "MAIL", "label": "Mail"}],
            "indexingStatus": [
                {"id": status.value.upper(), "label": label}
                for status, label in STATUS_LABELS.items()
            ],
            "sources": sources,
        }


def _sorted(nodes: list[dict[str, Any]], sort_by: str, descending: bool) -> list[dict[str, Any]]:
    if sort_by == "name":
        return sorted(nodes, key=lambda n: n["name"].casefold(), reverse=descending)
    key = "createdAt" if sort_by == "createdAt" else "updatedAt"
    return sorted(nodes, key=lambda n: n.get(key) or 0, reverse=descending)


def _crumb(node: dict[str, Any]) -> dict[str, Any]:
    return {"id": node["id"], "name": node["name"], "nodeType": node["nodeType"]}


def _kb_node(kb: KnowledgeBase) -> dict[str, Any]:
    return {
        "id": kb.id,
        "name": kb.name,
        "nodeType": "collection",
        "parentId": None,
        "origin": "COLLECTION",
        "hasChildren": True,
        "createdAt": ms(kb.created_at),
        "updatedAt": ms(kb.updated_at),
    }


def _mailbox_node(account_id: str, last: str | None) -> dict[str, Any]:
    at = ms(datetime.fromisoformat(last)) if last else None
    return {
        "id": account_id,
        "name": "Mail",
        "nodeType": "mailbox",
        "parentId": None,
        "origin": "CONNECTOR",
        "connector": "MAIL",
        "hasChildren": True,
        "createdAt": at,
        "updatedAt": at,
    }


def _folder_node(folder: Folder) -> dict[str, Any]:
    return {
        "id": folder.id,
        "name": folder.name,
        "nodeType": "folder",
        "parentId": folder.parent_id or folder.kb_id,
        "collectionId": folder.kb_id,
        "origin": "COLLECTION",
        "hasChildren": True,
        "createdAt": ms(folder.created_at),
        "updatedAt": ms(folder.updated_at),
    }


def _record_node(record: Record, *, attachments: int = 0) -> dict[str, Any]:
    extension = record.name.rsplit(".", 1)[-1].lower() if "." in record.name else None
    return {
        "id": record.id,
        "name": record.name,
        "nodeType": "record",
        "parentId": record.parent_id or record.folder_id or record.source_id,
        "collectionId": record.source_id if record.source_type == SourceType.UPLOAD else None,
        "folderId": record.folder_id,
        "origin": record.origin,
        "connector": "MAIL" if record.source_type == SourceType.MAIL else None,
        "hasChildren": attachments > 0,
        "attachmentCount": attachments,
        "createdAt": ms(record.created_at),
        "updatedAt": ms(record.updated_at),
        "sourceCreatedAt": ms(record.source_created_at),
        "sourceModifiedAt": ms(record.source_modified_at),
        "recordType": record.record_type,
        "indexingStatus": record.status.value.upper(),
        "stage": record.stage,
        "reason": record.reason,
        "sizeInBytes": record.size_bytes,
        "mimeType": record.mime_type,
        "extension": extension,
        "sourceType": record.source_type.value,
        "version": record.version,
        "threadId": record.mail.thread_id if record.mail else None,
    }
