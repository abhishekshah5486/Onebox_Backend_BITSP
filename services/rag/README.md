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
  file's real type is read from its bytes. Re-uploading it to the same place returns the
  existing record (`duplicate: true`).
- `GET /rag/records` (`limit`, `before`, `status`, `sourceType`, `sourceId`),
  `GET /rag/records/{id}`, `GET /rag/records/{id}/blocks` (the parsed blocks),
  `DELETE /rag/records/{id}` (with its attachments' records).

## How it works

Following PipesHub's design:

- **Records and contents.** A record is an item in a source (an uploaded file, an email, an
  attachment). Identical bytes for one user share one content (PipesHub's virtual record), which
  is stored, parsed and indexed once; every record holding it mirrors its status.
- **Statuses.** `queued` / `in_progress` (with `stage` `parse` or `index`), then `completed`,
  `empty`, `file_type_not_supported`, `password_protected` or `failed` (with a `reason`: too
  big, a zip bomb, unreadable). The same bytes always give the same outcome.
- **Blocks.** Parsers produce a container of blocks and block groups linked by index: tables
  are groups of row blocks, lists groups of items, and each block carries citation metadata
  (heading path, line, page, row, sheet, cell, slide). Stored gzipped in the blob store.
- **Parsing.** Jobs on the `rag-ingest` BullMQ queue (the TypeScript job envelope, one per
  content revision), consumed in-process unless `RAG_RUN_WORKER=false`. Parsing and inspection run in a pool of
  worker processes (PipesHub's lanes: one thread and one process each, one file at a time), so
  a hostile or huge file can only take down its own worker. A file past `RAG_PARSE_TIMEOUT_S`
  has its worker's process group killed and fails; a worker killed outright (most likely out
  of memory) gets the file one retry, and a second death fails it.
- **Routing.** Each content's engine is chosen once per revision and recorded. A PDF is
  inspected first: scanned when at least half its pages have no text layer or fail
  pdfplumber's checks on a sample of up to 30 text pages (little text with big images, low
  text density, one dominant image, unmapped glyphs). Scanned PDFs go to OCR, those past
  `RAG_DOCLING_MAX_PAGES` or `RAG_DOCLING_MAX_MB` to pdfplumber, the rest to Docling. Until
  those engines land (milestones 5 to 7) a PDF is recorded as waiting for its engine.
- **Formats so far:** plain text and Markdown (markdown-it), HTML (selectolax), email (attachments become child records),
  JSON and JSON Lines, YAML, CSV and TSV, and other text.

## Check

```sh
uv run ruff check . && uv run ruff format --check .
uv run mypy
uv run pytest                  # unit tests
uv run pytest -m integration   # needs Docker (MongoDB, Redis via Testcontainers)
```

Dependencies are pinned exactly, and `exclude-newer` in `pyproject.toml` keeps every package,
transitive ones included, at least two weeks old when the lock is resolved.
