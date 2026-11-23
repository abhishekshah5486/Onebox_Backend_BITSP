# RAG service

Ingests the user's mail, mail attachments and (later) external sources, and returns grounded
passages with citations for automated replies. Python 3.13 and FastAPI, managed with
[uv](https://docs.astral.sh/uv/). The plan is in [`docs/rag-service-plan.md`](../../docs/rag-service-plan.md).

Its structure and approach follow [PipesHub](https://github.com/pipeshub-ai/pipeshub-ai)
(Apache-2.0): routing each file to the right parsing engine, typed blocks, and hybrid dense and
sparse search. The code here is our own.

## Run

```sh
uv sync                              # once
npm run dev -w @onebox/rag-service   # or `turbo run dev`, with the other services (port 4012)
```

Settings come from the repo's `.env`: `MONGO_URI`, `REDIS_URL`, `CREDENTIALS_ENCRYPTION_KEY`,
`BLOB_ACCESS_KEY`, `BLOB_SECRET_KEY`, and optionally `BLOB_ENDPOINT`, `RAG_BLOB_BUCKET`, the
`RAG_MAX_*` upload limits, `PORT`, `MONGO_DB`, `AUTH_SERVICE_URL`, `LOG_LEVEL` (all in
`src/onebox_rag/config.py`). Through the gateway it is at `/api/v1/rag`.

## API

- `POST /rag/documents`: multipart `files` (one or more) and an optional `knowledgeBase`. Each
  file's real type is read from its bytes; files too big, zip bombs and encrypted files are
  recorded as `rejected` with a reason; the rest are stored and queued for parsing.
  Re-uploading the same content returns the existing record (`duplicate: true`).
- `GET /rag/records` (`limit`, `before`, `status`, `sourceType`, `sourceId`),
  `GET /rag/records/{id}`, `DELETE /rag/records/{id}`.

Parse jobs go to the `rag-ingest` BullMQ queue with the same envelope as the TypeScript
services' jobs, so they can enqueue into it too.

## Check

```sh
uv run ruff check . && uv run ruff format --check .
uv run mypy
uv run pytest                  # unit tests
uv run pytest -m integration   # needs Docker (MongoDB, Redis via Testcontainers)
```

Dependencies are pinned exactly, and `exclude-newer` in `pyproject.toml` keeps every package,
transitive ones included, at least two weeks old when the lock is resolved.
