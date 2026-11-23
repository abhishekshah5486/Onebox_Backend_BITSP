"""RAG's own Qdrant collections, one per embedding model (`rag_<model>_<dims>`), apart from the
collections in-app search uses. Each point has a dense and a BM25 sparse vector, and its
payload names the user and content it came from."""

import re
from dataclasses import dataclass
from typing import Any

from qdrant_client import AsyncQdrantClient, models

from onebox_rag.index.embed import EmbeddingModel, SparseVector

DENSE, SPARSE = "dense", "sparse"
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
            # Every search filters by user (Qdrant keeps each tenant's points together) and
            # by content.
            await self._client.create_payload_index(
                name,
                "userId",
                models.KeywordIndexParams(type=models.KeywordIndexType.KEYWORD, is_tenant=True),
            )
            await self._client.create_payload_index(
                name, "contentId", models.PayloadSchemaType.KEYWORD
            )
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
        must_not = (
            [models.FieldCondition(key="revision", match=models.MatchValue(value=keep_revision))]
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
    ) -> list[Hit]:
        """Dense and BM25 legs, each twice the limit deep and filtered where it searches, fused by
        reciprocal rank."""
        must: list[models.Condition] = [
            models.FieldCondition(key="userId", match=models.MatchValue(value=user_id))
        ]
        if content_ids is not None:
            must.append(
                models.FieldCondition(key="contentId", match=models.MatchAny(any=content_ids))
            )
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
