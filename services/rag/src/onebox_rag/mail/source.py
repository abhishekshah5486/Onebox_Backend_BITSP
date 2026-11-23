"""The mail source: every email the user keeps (not spam, trash or drafts) is a record whose
content is its latest reply, with a child record per attachment."""

import io
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from onebox_rag.ingest.ingestor import Ingestor, Source
from onebox_rag.ingest.records import RecordStore
from onebox_rag.mail.client import MailClient
from onebox_rag.mail.reply import latest_reply
from onebox_rag.models import Record, SourceType
from onebox_rag.models.records import Address, MailInfo

logger = logging.getLogger("onebox_rag.mail")
NO_SUBJECT = "(no subject)"


class MailSource:
    def __init__(
        self,
        records: RecordStore,
        ingestor: Ingestor,
        mail: MailClient,
        max_file_bytes: int,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._records, self._ingestor, self._mail = records, ingestor, mail
        self._max_file_bytes, self._now = max_file_bytes, now

    async def handle(self, user_id: str, payload: dict[str, Any]) -> None:
        op, version = payload["op"], int(payload["version"])
        if op == "delete":
            await self._drop_copy(payload["messageId"], version)
            return
        record = await self._records.by_external_id(
            user_id, SourceType.MAIL, payload["accountId"], payload["key"]
        )
        if record is not None and record.mail is not None and record.mail.version > version:
            return  # a later change already landed
        if op == "remove":
            if record is not None:
                await self._ingestor.delete(user_id, record.id)
                logger.info("email left rag", extra={"recordId": record.id})
            return
        copies = list(payload["messageIds"])
        if record is not None and record.mail is not None and record.mail.attachments_done:
            await self._set_mail(
                record, record.mail.model_copy(update={"copy_ids": copies, "version": version})
            )
            return
        await self._read(user_id, payload, copies, version, record)

    async def _read(
        self,
        user_id: str,
        payload: dict[str, Any],
        copies: list[str],
        version: int,
        record: Record | None,
    ) -> None:
        message = None
        for message_id in copies:
            message = await self._mail.message(user_id, message_id)
            if message is not None:
                break
        if message is None:
            return  # every copy went meanwhile; their deletes follow
        source = Source(SourceType.MAIL, payload["accountId"])
        if record is None:
            body = latest_reply(message.get("htmlBody"), message.get("textBody") or "")
            if body is None:
                body_bytes, mime = b"", "text/plain"
            else:
                body_bytes, mime = body.data, body.mime_type
            done = await self._ingestor.ingest(
                user_id=user_id,
                source=source,
                name=(message.get("subject") or "").strip() or NO_SUBJECT,
                declared_mime_type=mime,
                stream=io.BytesIO(body_bytes),
                external_id=payload["key"],
            )
            record = done.record
        info = _mail_info(payload["key"], copies, version, message)
        await self._set_mail(record, info)
        complete = await self._attachments(user_id, source, record, message)
        await self._set_mail(record, info.model_copy(update={"attachments_done": complete}))
        logger.info(
            "email read",
            extra={"recordId": record.id, "attachments": len(message.get("attachments") or [])},
        )

    async def _attachments(
        self, user_id: str, source: Source, parent: Record, message: dict[str, Any]
    ) -> bool:
        complete = True
        for meta in message.get("attachments") or []:
            external_id = f"{parent.external_id}/attachments/{meta['index']}"
            if await self._records.by_external_id(user_id, source.type, source.id, external_id):
                continue
            if int(meta.get("sizeBytes") or 0) > self._max_file_bytes:
                continue  # past what RAG reads; not worth downloading
            data = await self._mail.attachment(user_id, message["id"], int(meta["index"]))
            if data is None:
                complete = False  # the mail server can't give it now
                continue
            await self._ingestor.ingest(
                user_id=user_id,
                source=source,
                name=meta.get("filename") or "attachment",
                declared_mime_type=meta.get("contentType"),
                stream=io.BytesIO(data),
                external_id=external_id,
                parent_id=parent.id,
            )
        return complete

    async def _drop_copy(self, message_id: str, version: int) -> None:
        record = await self._records.with_mail_copy(message_id)
        if record is None or record.mail is None or record.mail.version > version:
            return
        left = [c for c in record.mail.copy_ids if c != message_id]
        if left:
            await self._set_mail(
                record, record.mail.model_copy(update={"copy_ids": left, "version": version})
            )
            return
        await self._ingestor.delete(record.user_id, record.id)
        logger.info("email left rag", extra={"recordId": record.id})

    async def _set_mail(self, record: Record, info: MailInfo) -> None:
        await self._records.update(record.id, self._now(), mail=info.model_dump(by_alias=True))

    async def close(self) -> None:
        await self._mail.close()


def _mail_info(key: str, copies: list[str], version: int, message: dict[str, Any]) -> MailInfo:
    def address(value: Any) -> Address | None:
        return Address.model_validate(value) if isinstance(value, dict) else None

    received = message.get("receivedAt")
    return MailInfo(
        key=key,
        copy_ids=copies,
        version=version,
        thread_id=message.get("threadId"),
        message_id_header=message.get("messageIdHeader"),
        sender=address(message.get("from")),
        to=[a for a in map(address, message.get("to") or []) if a],
        cc=[a for a in map(address, message.get("cc") or []) if a],
        received_at=datetime.fromisoformat(received) if received else None,
    )
