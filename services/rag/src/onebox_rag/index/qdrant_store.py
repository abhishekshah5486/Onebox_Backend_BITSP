"""RAG's own Qdrant collections, one per embedding model (`rag_<model>_<dims>`), apart from the
collections in-app search uses. Each point has a dense and a BM25 sparse vector, and its
payload names the user and content it came from."""

import re
from dataclasses import dataclass
from typing import Any

from qdrant_client import AsyncQdrantClient, models

from onebox_rag.dates import DateBounds
from onebox_rag.index.embed import EmbeddingModel, SparseVector

DENSE, SPARSE = "dense", "sparse"
# Payload fields date filters read, and the kind of a record's title point (it belongs to the
# record, not to a revision of its content).
CREATED, MODIFIED = "createdAt", "modifiedAt"
TITLE = "title"
UPSERT_BATCH = 256
# RRF ties hits of equal rank, which Qdrant returns in any order; a few more are fetched and
# ties broken by id, so the same query always ranks the same.
TIE_MARGIN = 2


@dataclass(frozen=True)
class Hit:
    id: str
    score: float
    payload: dict[str, Any]


@dataclass(frozen=True)
class SearchTuning:
    # The dense leg's search beam, and how many times the depth the int8 scan hands to the
    # full-precision rescore.
    hnsw_ef: int = 256
    oversampling: float = 1.5


@dataclass(frozen=True)
class StoredPoint:
    id: str
    dense: list[float]
    sparse: SparseVector
    payload: dict[str, Any]


def collection_name(model: EmbeddingModel) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", model.id.lower()).strip("_")
    return f"rag_{slug}_{model.dimensions}"


class QdrantStore:
    def __init__(self, url: str, api_key: str | None, timeout_s: float) -> None:
        self._client = AsyncQdrantClient(url=url, api_key=api_key or None, timeout=int(timeout_s))
        self._ready: set[str] = set()

    async def ensure_collection(self, model: EmbeddingModel) -> str:
        name = collection_name(model)
        if name in self._ready:
            return name
        if not await self._client.collection_exists(name):
            try:
                await self._client.create_collection(
                    name,
                    vectors_config={
                        DENSE: models.VectorParams(
                            size=model.dimensions, distance=models.Distance.COSINE, on_disk=True
                        )
                    },
                    # BM25 gives term weights; IDF comes from the collection.
                    sparse_vectors_config={
                        SPARSE: models.SparseVectorParams(
                            index=models.SparseIndexParams(on_disk=True),
                            modifier=models.Modifier.IDF,
                        )
                    },
                    hnsw_config=models.HnswConfigDiff(on_disk=True),
                    quantization_config=models.ScalarQuantization(
                        scalar=models.ScalarQuantizationConfig(
                            type=models.ScalarType.INT8, quantile=0.95, always_ram=False
                        )
                    ),
                )
            except Exception:
                # Another worker may have made it first.
                if not await self._client.collection_exists(name):
                    raise
            # Every search filters by user (Qdrant keeps each tenant's points together).
            await self._client.create_payload_index(
                name,
                "userId",
                models.KeywordIndexParams(type=models.KeywordIndexType.KEYWORD, is_tenant=True),
            )
        # Also made for collections created before them; making one that exists is a no-op.
        for field, schema in (
            ("contentId", models.PayloadSchemaType.KEYWORD),
            ("recordId", models.PayloadSchemaType.KEYWORD),
            ("kind", models.PayloadSchemaType.KEYWORD),
            (CREATED, models.PayloadSchemaType.DATETIME),
            (MODIFIED, models.PayloadSchemaType.DATETIME),
        ):
            await self._client.create_payload_index(name, field, schema)
        self._ready.add(name)
        return name

    async def upsert(self, collection: str, points: list[StoredPoint]) -> None:
        for start in range(0, len(points), UPSERT_BATCH):
            await self._client.upsert(
                collection,
                [
                    models.PointStruct(
                        id=p.id,
                        vector={
                            DENSE: p.dense,
                            SPARSE: models.SparseVector(
                                indices=p.sparse.indices, values=p.sparse.values
                            ),
                        },
                        payload=p.payload,
                    )
                    for p in points[start : start + UPSERT_BATCH]
                ],
                wait=True,
            )

    async def delete_content(
        self, collection: str, content_id: str, keep_revision: int | None = None
    ) -> None:
        """A content's points, or with `keep_revision` those of its older revisions."""
        # A re-index keeps the record's title points, which belong to no revision.
        must_not = (
            [
                models.FieldCondition(key="revision", match=models.MatchValue(value=keep_revision)),
                _match("kind", TITLE),
            ]
            if keep_revision is not None
            else None
        )
        if not await self._client.collection_exists(collection):
            return
        await self._client.delete(
            collection,
            models.FilterSelector(
                filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="contentId", match=models.MatchValue(value=content_id)
                        )
                    ],
                    must_not=must_not,
                )
            ),
            wait=True,
        )

    async def set_dates(
        self, collection: str, content_id: str, created: list[str], modified: list[str]
    ) -> None:
        """The dates of the records holding a content, on its points (title points carry
        their own record's)."""
        await self._client.set_payload(
            collection,
            {CREATED: created, MODIFIED: modified},
            points=models.Filter(
                must=[_match("contentId", content_id)], must_not=[_match("kind", TITLE)]
            ),
            wait=True,
        )

    async def replace_titles(
        self, collection: str, record_ids: list[str], points: list[StoredPoint]
    ) -> None:
        """Drops these records' title points, then writes the given ones."""
        await self._client.delete(
            collection,
            models.FilterSelector(
                filter=models.Filter(
                    must=[
                        _match("kind", TITLE),
                        models.FieldCondition(
                            key="recordId", match=models.MatchAny(any=record_ids)
                        ),
                    ]
                )
            ),
            wait=True,
        )
        await self.upsert(collection, points)

    async def search_titles(
        self,
        collection: str,
        dense: list[float],
        *,
        user_id: str,
        content_ids: list[str] | None,
        limit: int,
        min_score: float,
        dates: DateBounds | None = None,
    ) -> list[Hit]:
        """Title points by meaning alone, above a cosine floor: names are a few words, and
        a near miss of a name is no match."""
        must = [*_scope(user_id, content_ids), _match("kind", TITLE)]
        if dates is not None:
            must += _date_conditions(dates)
        response = await self._client.query_points(
            collection,
            query=dense,
            using=DENSE,
            query_filter=models.Filter(must=must),
            limit=limit,
            score_threshold=min_score,
            with_payload=True,
        )
        return [
            Hit(str(p.id), float(p.score or 0.0), dict(p.payload or {})) for p in response.points
        ]

    async def count(self, collection: str, content_id: str) -> int:
        result = await self._client.count(
            collection,
            count_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="contentId", match=models.MatchValue(value=content_id)
                    )
                ]
            ),
            exact=True,
        )
        return int(result.count)

    async def search(
        self,
        collection: str,
        dense: list[float],
        sparse: SparseVector,
        *,
        user_id: str,
        content_ids: list[str] | None,
        limit: int,
        tuning: SearchTuning,
        dates: DateBounds | None = None,
    ) -> list[Hit]:
        """Dense and BM25 legs, each twice the limit deep and filtered where it searches, fused by
        reciprocal rank."""
        must = _scope(user_id, content_ids)
        if dates is not None:
            must += _date_conditions(dates)
        where = models.Filter(must=must)
        response = await self._client.query_points(
            collection,
            prefetch=[
                models.Prefetch(
                    query=dense,
                    using=DENSE,
                    limit=limit * 2,
                    filter=where,
                    params=models.SearchParams(
                        hnsw_ef=tuning.hnsw_ef or None,
                        quantization=models.QuantizationSearchParams(
                            rescore=True, oversampling=tuning.oversampling
                        ),
                    ),
                ),
                models.Prefetch(
                    query=models.SparseVector(indices=sparse.indices, values=sparse.values),
                    using=SPARSE,
                    limit=limit * 2,
                    filter=where,
                ),
            ],
            query=models.FusionQuery(fusion=models.Fusion.RRF),
            query_filter=where,
            limit=limit + TIE_MARGIN,
            with_payload=True,
        )
        points = sorted(response.points, key=lambda p: (-(p.score or 0.0), str(p.id)))[:limit]
        return [Hit(str(p.id), float(p.score or 0.0), dict(p.payload or {})) for p in points]

    async def exists(self, collection: str) -> bool:
        return bool(await self._client.collection_exists(collection))

    async def ping(self) -> None:
        await self._client.get_collections()

    async def close(self) -> None:
        await self._client.close()


def _scope(user_id: str, content_ids: list[str] | None) -> list[models.Condition]:
    must: list[models.Condition] = [_match("userId", user_id)]
    if content_ids is not None:
        must.append(models.FieldCondition(key="contentId", match=models.MatchAny(any=content_ids)))
    return must


def _match(key: str, value: str) -> models.FieldCondition:
    return models.FieldCondition(key=key, match=models.MatchValue(value=value))


def _date_conditions(dates: DateBounds) -> list[models.Condition]:
    """A point passes when one of its dates is in range (a content shared by several records
    carries all their dates)."""
    conditions: list[models.Condition] = []
    for key, after, before in (
        (CREATED, dates.created_after, dates.created_before),
        (MODIFIED, dates.modified_after, dates.modified_before),
    ):
        if after is not None or before is not None:
            conditions.append(
                models.FieldCondition(key=key, range=models.DatetimeRange(gte=after, lte=before))
            )
    return conditions
