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

PDF, Word and PowerPoint files are read by the separate Docling service (port 4013):

```sh
uv sync --extra docling                  # once; PyTorch and Docling's models
npm run dev:docling -w @onebox/rag-service
```

It needs LibreOffice (`soffice`) for DOC, RTF, ODT, PPT and ODP. Without it running, PDFs
are read by the pdfplumber engine instead, and Word and PowerPoint files are retried and then
fail as "the Docling service is unavailable" (`RAG_DOCLING_URL=`, empty, leaves those waiting).

Indexing needs Qdrant (`docker compose --profile vector up -d qdrant`) and llm-proxy;
`QDRANT_URL=` (empty) leaves parsed content waiting to be indexed.

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
  `RAG_DOCLING_MAX_PAGES` or `RAG_DOCLING_MAX_MB` to pdfplumber, the rest to Docling. Image
  files (PNG, JPEG, WebP, TIFF, BMP, GIF) go to OCR too.
- **Docling.** Digital PDFs, Word and PowerPoint go to the Docling service with these
  options: no Docling OCR unless `DOCLING_OCR=rapidocr` (it then reads text inside pictures;
  scanned pages have their own engine either way), accurate tables, picture
  images kept, and only PDF, DOCX and PPTX allowed whatever the bytes resemble. DOC, RTF, ODT,
  PPT and ODP are converted first by headless LibreOffice (a throwaway profile and process
  group per file). Conversions run in the same kind of worker pool, so timeouts and
  out-of-memory kills are handled the same way, and it answers 429 when every worker is busy.
  Its document becomes blocks in reading order: heading paths, lists, tables (header rows,
  captions), pictures (captions as their text), and each item's page or slide with its box.
- **pdfplumber + OpenCV.** PDFs past Docling's limits, or any PDF while Docling is down
  (recorded as `docling_unavailable`), are read from pdfplumber's words and vectors and an
  OpenCV pass over a 100 DPI raster: two-column pages by their gutter, then paragraphs,
  headings (one short line that is bold or 1.15x the body size; levels by size), bullet and
  numbered lists (an unmapped glyph opening a line counts as a bullet), tables (pdfplumber's
  ruled ones, grids OpenCV finds on the raster that have no vector rules, and borderless ones
  of 3+ aligned columns over 3+ lines), and pictures cropped from the raster with their
  "Figure ..." captions. Running headers and footers repeated across pages are kept once and
  page numbers dropped. About 300 pages in 3 seconds.
- **OCR.** Scanned PDFs and image files, by `RAG_OCR_PROVIDER`:
  - `rapidocr` (default): free and local, PP-OCR models on ONNX Runtime. Pages render at
    `RAG_OCR_DPI` (200) and their words go through the same layout pass as pdfplumber's, so
    columns, headings (size from ink height, bold from stroke width), lists and tables come
    out alike. Each image frame is a page, with the picture kept as an image block.
  - `vision`: each page sent to a vision model (`RAG_VISION_MODEL` at `RAG_VISION_BASE_URL`,
    any OpenAI-compatible API, a local Ollama by default) for Markdown, parsed per page;
    `{{IMAGE: ...}}` becomes an image block with that description. Temperature 0, 2 retries, 10
    calls at once; a cut-off answer or an unreachable model falls back to RapidOCR. Answers are
    cached in the blob store per image, model and prompt.
    The provider is recorded per revision; jobs get `RAG_OCR_SECONDS_PER_PAGE` per page on top
    of the parse timeout, and files past `RAG_OCR_MAX_PAGES` (500) fail.
- **Image descriptions.** With a vision model set, up to `RAG_DESCRIBE_MAX_IMAGES` (60)
  pictures per file get a description (any text in them transcribed too), capped at 8,000
  characters; tiny, thin or icon-sized ones are skipped, and one that fails keeps its caption.
- **Spreadsheets.** CSV and TSV, Excel (XLSX, XLSM; openpyxl, cached formula values), and
  XLS, ODS and XLSB after the Docling service's LibreOffice turns them into XLSX. Each sheet
  is a group; in it every rectangle of cells bounded by empty rows and columns is a table
  (titles above it become text). Merged cells fill each cell they cover, dates and
  percentages read as shown, and rows are cited by sheet, row and cell range; at most 20,000
  rows per table. Header rows are only guessed at parse time, kept as flagged row blocks.
- **Table enrichment.** Every table, from any format, goes to the user's model through
  llm-proxy (`RAG_LLM_PROXY_URL`; billed and cached there): one call decides a sheet's
  header rows (several rows join into "Group - Column" names), names unlabeled columns and
  writes a summary; then rows go 50 at a time (`RAG_TABLE_ROW_BATCH`), each tagged with a
  short key the answer must copy, so a skipped or reordered row can't take another's
  sentence. Up to `RAG_TABLE_LLM_ROWS` (1,000) rows per file get sentences; the rest, and any
  row the model leaves out or a failed call, keep "column: value" text. A user out of AI
  credits gets plain tables. `RAG_TABLE_ENRICHMENT=false` turns it off.
- **Indexing.** Parsed content goes to the `rag-index` queue. Each block becomes a point
  rather than fixed-size chunks: a paragraph, heading, list item, row sentence or image
  description, plus one point per table (its summary and columns). A block of more than 100
  words also gets a point per sentence (pysbd, in the language lingua detects for the
  record), and one longer than `RAG_INDEX_MAX_BLOCK_CHARS` becomes overlapping 1,500
  character windows instead. Points get a dense vector from the user's embedding model
  through llm-proxy (not charged) and a BM25 sparse vector computed here (fastembed), and go
  into RAG's own Qdrant collection for that model, `rag_<model>_<dims>` (never search's):
  `dense` and `sparse` vectors (IDF from Qdrant), int8 quantization, on-disk storage, and the
  user, content, revision, block, kind, text and citation in the payload. Point ids hash the
  content, revision, block and text, so retries overwrite; a new revision is written before
  the old one's points are deleted, and deleting content deletes its points. The content is
  then `completed`.
- **Formats so far:** plain text and Markdown (markdown-it), HTML (selectolax), email (attachments become child records),
  JSON and JSON Lines, YAML, CSV and TSV, spreadsheets, PDF, Word, PowerPoint, images, and
  other text.

## Check

```sh
uv run ruff check . && uv run ruff format --check .
uv run mypy
uv run pytest                  # unit tests
uv run pytest -m integration   # needs Docker (MongoDB, Redis via Testcontainers); the
                               # Docling tests also need the docling extra and LibreOffice
```

Dependencies are pinned exactly, and `exclude-newer` in `pyproject.toml` keeps every package,
transitive ones included, at least two weeks old when the lock is resolved.
