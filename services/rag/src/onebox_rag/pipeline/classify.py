"""After a content is searchable, a model classifies it and writes a retrieval-facing summary;
the summary becomes one more point of the content, found as the whole record. Every content
goes the same way, mail or file; a failure leaves it searchable without one."""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from onebox_rag.index.embed import DenseEmbedder, sparse_documents
from onebox_rag.index.points import POINT_NAMESPACE, PointKind, SplitSettings
from onebox_rag.index.qdrant_store import QdrantStore, StoredPoint, collection_name
from onebox_rag.index.texts import embed_text
from onebox_rag.index.tokens import count_tokens
from onebox_rag.ingest.blobs import BlobStore
from onebox_rag.ingest.queue import IngestQueue
from onebox_rag.ingest.records import ContentStore, RecordStore
from onebox_rag.models import Content, Record, Status
from onebox_rag.models.blocks import BlocksContainer, BlockType
from onebox_rag.models.records import Classification, ClassifyStatus, Subcategories
from onebox_rag.pipeline.llm import (
    InvalidOutputError,
    LlmClient,
    LlmUnavailableError,
    OutOfCreditsError,
)
from onebox_rag.pipeline.parse import decode_blocks
from onebox_rag.pipeline.prompts import (
    DOCUMENT_CLASSIFY_PROMPT,
    DOCUMENT_RECORD_HEADER,
    FALLBACK_SUMMARY_PROMPT,
)

logger = logging.getLogger("onebox_rag.classify")

# The share of the model's context the document may take; the rest is instructions and answer.
CONTENT_TOKEN_RATIO = 0.85
# Kept per content; more is a listing, not what it is about.
MAX_ORGANIZATIONS = 10
# Held to their size cap and indexed for search only: no model call.
UNCLASSIFIED_EXTENSIONS = frozenset({"log", "cfg"})

CLASSIFICATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["category", "subcategories", "languages", "topics", "organizations", "summary"],
    "properties": {
        "category": {"type": "string", "description": "Main category this document belongs to"},
        "subcategories": {
            "type": "object",
            "description": "Nested subcategories for the document",
            "additionalProperties": False,
            "required": ["level1", "level2", "level3"],
            "properties": {
                "level1": {"type": "string", "description": "Level 1 subcategory"},
                "level2": {"type": "string", "description": "Level 2 subcategory"},
                "level3": {"type": "string", "description": "Level 3 subcategory"},
            },
        },
        "languages": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Natural languages the document is written in",
        },
        "topics": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "2 to 5 (usually 2 or 3) reusable subjects a reader would look for across "
                "documents, lowercase except acronyms; never a person, company, document title, "
                "date, amount or id"
            ),
        },
        "organizations": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Organizations the document names as parties, customers, vendors, partners, "
                "employers, regulators or institutions, verbatim. Not people, products, teams "
                "or the application the document came from."
            ),
        },
        "summary": {
            "type": "string",
            "description": (
                "Retrieval-facing summary. Sentence 1 must state document type, primary subject, "
                "principal parties or owning team, and time period or effective date, in that "
                "order — a downstream tool shows only the first ~600 characters, so "
                "front-loading is mandatory. Length is tiered to document depth: 3-5 sentences "
                "for thin/sparse documents, no more than 300 words typically, never exceeding "
                "400 words. Prefer concrete named entities, identifiers, dates, and figures over "
                "connective prose. No opening filler, meta commentary, recommendations, or "
                "unsupported claims."
            ),
        },
    },
}


@dataclass(frozen=True)
class ClassifySettings:
    enabled: bool = True
    # Wait until a search first returns a content, instead of right after it is indexed.
    on_first_use: bool = False
    # The model's context when it doesn't say (llm-proxy doesn't for hosted models).
    context_tokens: int = 128_000
    max_output_tokens: int = 2000

    def status_after_index(self) -> ClassifyStatus:
        if not self.enabled:
            return ClassifyStatus.SKIPPED
        return ClassifyStatus.DEFERRED if self.on_first_use else ClassifyStatus.QUEUED


def prepare_content(container: BlocksContainer, budget_tokens: int) -> list[str]:
    """The text the model reads: text blocks, table-row sentences and code, in order, up to
    `budget_tokens` (the rest is left out from the first block that would pass it)."""
    parts: list[str] = []
    total = 0
    for block in container.blocks:
        if block.type == BlockType.TABLE_ROW:
            text = embed_text(block)
        elif block.type in (BlockType.TEXT, BlockType.CODE):
            text = block.text()
        else:
            continue  # images: a text-only model is not shown them
        if not text.strip():
            continue
        tokens = count_tokens(text)
        if total + tokens > budget_tokens:
            logger.info("classify input cut to its head", extra={"tokens": total})
            break
        parts.append(text)
        total += tokens
    return parts


def record_type(record: Record) -> str:
    return "MAIL" if record.mail is not None else "FILE"


def record_header(record: Record) -> str:
    # replace, not format: a name may hold braces.
    return DOCUMENT_RECORD_HEADER.replace("{record_name}", record.name or "(unknown)").replace(
        "{record_type}", record_type(record)
    )


def classifies(record: Record) -> bool:
    name = record.name or ""
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else None
    return extension not in UNCLASSIFIED_EXTENSIONS


def classification_from(output: Any) -> Classification | None:
    """The model's answer as stored; None when it has no summary."""
    if not isinstance(output, dict):
        return None
    summary = output.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return None

    def names(values: Any) -> list[str]:
        kept = (v.strip() for v in values or [] if isinstance(v, str) and v.strip())
        return list(dict.fromkeys(kept))

    seen: set[str] = set()
    organizations = []
    for name in names(output.get("organizations")):
        if name.casefold() not in seen:
            seen.add(name.casefold())
            organizations.append(name)
    raw_levels = output.get("subcategories")
    levels: dict[str, Any] = raw_levels if isinstance(raw_levels, dict) else {}
    category = output.get("category")
    return Classification(
        summary=summary.strip(),
        category=category.strip() or None if isinstance(category, str) else None,
        subcategories=Subcategories(
            **{k: str(levels.get(k) or "").strip() for k in ("level1", "level2", "level3")}
        ),
        languages=names(output.get("languages")),
        topics=names(output.get("topics")),
        organizations=organizations[:MAX_ORGANIZATIONS],
    )


class SummaryPoint:
    """A content's summary as a point of its own, beside its blocks' points."""

    def __init__(self, dense: DenseEmbedder, store: QdrantStore, split: SplitSettings) -> None:
        self._dense, self._store, self._split = dense, store, split

    async def write(self, content: Content, summary: str) -> bool:
        """False when the content is not in the user's current collection (its next index
        writes it there)."""
        model = await self._dense.model_for(content.user_id)
        collection = collection_name(model)
        if collection != content.index_collection:
            return False
        pieces = self._split.window_for(model.id, model.context_tokens).split(summary)
        dense, sparse = await asyncio.gather(
            self._dense.embed(content.user_id, model, pieces),
            asyncio.to_thread(sparse_documents, pieces),
        )
        points = [
            StoredPoint(
                id=str(
                    uuid.uuid5(POINT_NAMESPACE, f"{content.id}|{content.revision}|summary|{piece}")
                ),
                dense=vector,
                sparse=terms,
                payload={
                    "userId": content.user_id,
                    "contentId": content.id,
                    "revision": content.revision,
                    "kind": PointKind.SUMMARY.value,
                    "blockIndex": None,
                    "groupIndex": None,
                    "text": piece,
                },
            )
            for piece, vector, terms in zip(pieces, dense, sparse, strict=True)
        ]
        await self._store.replace_kind(collection, content.id, PointKind.SUMMARY.value, points)
        return True


class ClassifyStage:
    def __init__(
        self,
        contents: ContentStore,
        records: RecordStore,
        blobs: BlobStore,
        llm: LlmClient,
        point: SummaryPoint,
        settings: ClassifySettings,
        # Gives the new point its records' dates.
        dated: Callable[[str], Awaitable[None]] | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._contents, self._records, self._blobs = contents, records, blobs
        self._llm, self._point, self._settings = llm, point, settings
        self._dated, self._now = dated, now

    async def run(self, content_id: str, revision: int, *, final_attempt: bool) -> None:
        content = await self._contents.get(content_id)
        if (
            content is None
            or content.revision != revision
            or content.status != Status.COMPLETED
            or content.blocks_key is None
            or content.index_collection is None
        ):
            return
        if content.classified_revision == revision and content.classification is not None:
            await self._write_point(content, content.classification)
            return
        holders = await self._records.for_content(content_id)
        if not holders:
            return
        record = max(holders, key=lambda r: r.created_at)
        if not classifies(record):
            await self._settle(content_id, ClassifyStatus.SKIPPED, "indexed for search only")
            return
        container = decode_blocks(await self._blobs.get(content.blocks_key))
        budget = int(self._settings.context_tokens * CONTENT_TOKEN_RATIO)
        parts = await asyncio.to_thread(prepare_content, container, budget)
        if not parts:
            await self._settle(content_id, ClassifyStatus.SKIPPED, "nothing to classify")
            return
        document = "\n".join([record_header(record), "Document Content: ", *parts])
        try:
            classification = await self._classify(content.user_id, document)
        except OutOfCreditsError:
            await self._settle(content_id, ClassifyStatus.FAILED, "out of AI credits")
            return
        except LlmUnavailableError as err:
            logger.warning("classify unavailable", extra={"contentId": content_id, "why": str(err)})
            if final_attempt:
                await self._settle(content_id, ClassifyStatus.FAILED, "no model could answer")
                return
            raise
        if classification is None:
            await self._settle(content_id, ClassifyStatus.FAILED, "the model gave no summary")
            return
        latest = await self._contents.get(content_id)
        if latest is None or latest.revision != revision:
            return  # a new version landed meanwhile; it is classified on its own
        saved = await self._contents.update(
            content_id,
            self._now(),
            classification=classification.model_dump(by_alias=True),
            classify_status=ClassifyStatus.COMPLETED,
            classify_reason=None,
            classified_revision=revision,
        )
        if saved is not None:
            await self._write_point(saved, classification)
        logger.info("classified", extra={"contentId": content_id})

    async def _classify(self, user_id: str, document: str) -> Classification | None:
        # The instructions go first and alone, so every content sends the same cached prefix.
        try:
            output = await self._llm.json(
                user_id,
                [
                    {"role": "system", "content": DOCUMENT_CLASSIFY_PROMPT},
                    {"role": "user", "content": document},
                ],
                "document_classification",
                CLASSIFICATION_SCHEMA,
                max_output_tokens=self._settings.max_output_tokens,
                subject="rag-classify",
            )
        except InvalidOutputError:
            output = None
        classification = classification_from(output)
        if classification is not None:
            return classification
        logger.warning("structured classify failed; asking for a plain summary")
        # The instructions carry the summary rules, which the plain summary follows too.
        summary = await self._llm.text(
            user_id,
            [
                {
                    "role": "user",
                    "content": "\n".join(
                        [
                            FALLBACK_SUMMARY_PROMPT,
                            "Document Content: ",
                            DOCUMENT_CLASSIFY_PROMPT,
                            document,
                        ]
                    ),
                }
            ],
            max_output_tokens=self._settings.max_output_tokens,
            subject="rag-classify",
        )
        return Classification(summary=summary.strip()) if summary.strip() else None

    async def _write_point(self, content: Content, classification: Classification) -> None:
        if await self._point.write(content, classification.summary) and self._dated is not None:
            await self._dated(content.id)

    async def _settle(self, content_id: str, status: ClassifyStatus, reason: str) -> None:
        await self._contents.update(
            content_id, self._now(), classify_status=status, classify_reason=reason
        )


class ClassifyScheduler:
    """When a content is classified: right after it is indexed, or with `on_first_use` when a
    search first returns it. A content classified already only has its point written again
    (its user's embedding model changed)."""

    def __init__(
        self,
        contents: ContentStore,
        queue: IngestQueue,
        point: SummaryPoint,
        settings: ClassifySettings,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._contents, self._queue, self._point = contents, queue, point
        self._settings, self._now = settings, now

    async def after_index(self, indexed: Content) -> None:
        content = await self._contents.get(indexed.id)
        if content is None or content.revision != indexed.revision:
            return
        if content.classified_revision == content.revision and content.classification:
            await self._point.write(content, content.classification.summary)
            return
        status = self._settings.status_after_index()
        reason = "switched off" if status == ClassifyStatus.SKIPPED else None
        await self._contents.update(
            content.id, self._now(), classify_status=status, classify_reason=reason
        )
        if status == ClassifyStatus.QUEUED:
            await self._queue.enqueue(content.user_id, content.id, content.revision)

    async def first_use(self, contents: list[Content]) -> None:
        for content in contents:
            if content.classify_status != ClassifyStatus.DEFERRED:
                continue
            await self._contents.update(
                content.id, self._now(), classify_status=ClassifyStatus.QUEUED
            )
            await self._queue.enqueue(content.user_id, content.id, content.revision)
