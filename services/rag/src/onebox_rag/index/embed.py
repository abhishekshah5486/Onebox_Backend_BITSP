"""Dense vectors from the user's embedding model (through llm-proxy, which picks it and isn't
charging for indexing a user's own data) and BM25 sparse vectors computed here."""

import asyncio
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import httpx

from onebox_rag.auth import INTERNAL_TOKEN_HEADER

logger = logging.getLogger("onebox_rag.embed")

# llm-proxy takes at most this many texts per call.
MAX_TEXTS_PER_CALL = 64
SPARSE_MODEL = "Qdrant/bm25"


class EmbeddingUnavailableError(Exception):
    """The proxy or the model failed: the content is retried later."""


@dataclass(frozen=True)
class EmbeddingModel:
    id: str
    dimensions: int


@dataclass(frozen=True)
class SparseVector:
    indices: list[int]
    values: list[float]


class DenseEmbedder:
    def __init__(
        self,
        base_url: str,
        token: str,
        timeout_s: float,
        concurrency: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._token = token
        self._http = httpx.AsyncClient(
            base_url=base_url, timeout=httpx.Timeout(timeout_s, connect=5.0), transport=transport
        )
        self._slots = asyncio.Semaphore(concurrency)

    async def model_for(self, user_id: str) -> EmbeddingModel:
        """The user's embedding model (their semantic-search pick, or OneBox's default)."""
        body = await self._call("GET", "/internal/embed/model", params={"userId": user_id})
        return EmbeddingModel(str(body["id"]), int(body["dimensions"]))

    async def embed(
        self, user_id: str, model: EmbeddingModel, texts: list[str]
    ) -> list[list[float]]:
        batches = [
            texts[i : i + MAX_TEXTS_PER_CALL] for i in range(0, len(texts), MAX_TEXTS_PER_CALL)
        ]
        results = await asyncio.gather(*(self._batch(user_id, model, b) for b in batches))
        return [vector for batch in results for vector in batch]

    async def _batch(
        self, user_id: str, model: EmbeddingModel, texts: list[str]
    ) -> list[list[float]]:
        async with self._slots:
            body = await self._call(
                "POST",
                "/internal/embed",
                json={"userId": user_id, "texts": texts, "charge": False, "model": model.id},
            )
        vectors = body.get("vectors") or []
        if body.get("model") != model.id or len(vectors) != len(texts):
            raise EmbeddingUnavailableError("llm-proxy answered with another model or count")
        if any(len(v) != model.dimensions for v in vectors):
            raise EmbeddingUnavailableError("llm-proxy answered vectors of another size")
        return [list(map(float, v)) for v in vectors]

    async def _call(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = await self._http.request(
                method, path, headers={INTERNAL_TOKEN_HEADER: self._token}, **kwargs
            )
        except httpx.TransportError as err:
            raise EmbeddingUnavailableError(
                f"llm-proxy unreachable ({type(err).__name__})"
            ) from err
        if response.status_code != 200:
            raise EmbeddingUnavailableError(f"llm-proxy answered {response.status_code}")
        body: dict[str, Any] = response.json()
        return body

    async def close(self) -> None:
        await self._http.aclose()


@lru_cache(maxsize=1)
def _bm25() -> Any:
    from fastembed import SparseTextEmbedding

    # From the local cache when it's there (images bake it in); downloaded otherwise.
    try:
        return SparseTextEmbedding(model_name=SPARSE_MODEL, local_files_only=True)
    except Exception:
        return SparseTextEmbedding(model_name=SPARSE_MODEL)


def warm_sparse() -> None:
    _bm25()


def sparse_documents(texts: list[str]) -> list[SparseVector]:
    """Term weights only; Qdrant applies IDF over the collection when it scores."""
    return [SparseVector(e.indices.tolist(), e.values.tolist()) for e in _bm25().embed(texts)]


def sparse_query(text: str) -> SparseVector:
    embedding = next(iter(_bm25().query_embed(text)))
    return SparseVector(embedding.indices.tolist(), embedding.values.tolist())
