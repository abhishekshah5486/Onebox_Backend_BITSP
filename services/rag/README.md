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

- `POST /rag/documents`: multipart `files` (one or more), a collection id `knowledgeBase`, an
  optional `folderId`, and for a folder upload each file's relative `paths` (its folders are
  made inside the target). Each file's real type is read from its bytes. Re-uploading it to
  the same collection returns the existing record (`duplicate: true`), out of the trash if it
  was there.
- **Collections and folders.** `GET/POST /rag/collections`, `PATCH/DELETE
/rag/collections/{id}` (deleting removes its records for good), `POST
/rag/collections/{id}/folders` (`name`, `parentId`), `PATCH/DELETE
/rag/collections/{id}/folders/{folderId}` (deleting moves its files to the trash). Collection
  names are unique per user and folder names per parent, trimmed and in any case; folder names
  have no `/` or `\`, and folders nest at most 20 deep. Uploading to an id with no collection
  (e.g. `default`) makes one, as uploads did before collections.
- **Knowledge hub.** `GET /rag/hub/nodes` lists the collections and mailboxes;
  `GET /rag/hub/nodes/{collection|folder|mailbox|record}/{id}` lists what is in one (folders
  first, then its files, or an email's attachments). With any filter (`q`, `recordTypes`
  FILE/MAIL, `indexingStatus`, `sourceIds`, `createdAt`/`updatedAt`/`size` as `gte:X,lte:Y` in
  epoch ms or bytes), or `flattened=true`, it lists every record below the node instead.
  `sortBy` name/createdAt/updatedAt/size, `sortOrder`, `limit` (up to 200) and the opaque
  `cursor` from `pagination.nextCursor`; `include` adds `breadcrumbs`, `counts`,
  `permissions` and `availableFilters`.
- **Records.** `GET /rag/records` (filters below, `folderId` with `root` for a collection's
  top, `trashed`), `GET /rag/records/{id}`, `GET /rag/records/{id}/blocks` (the parsed blocks),
  `PATCH /rag/records/{id}` (`name`, unique in its folder), `POST /rag/records/{id}/move`
  (`collectionId`, `folderId`), `DELETE /rag/records/{id}` (to the trash, or `?permanent=true`
  for good, its attachments' records included), `POST /rag/records/trash` and
  `POST /rag/records/restore` (`ids`; one whose folder went comes back to the top). Trashed
  records are left out of lists and searches. Each record says its `recordType` (`FILE` or
  `MAIL`) and `origin` (`UPLOAD` or `CONNECTOR`).

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
  description, plus one point per table (its summary). A table's rows and summary are
  led by its title: the short lines right above it, and a sheet's name, so "Q3 sales
  North revenue" finds a row that only says "Region: North, Revenue: 1200". URLs are
  embedded as their host, and images as their description plus alt text. A block of more than 100
  words also gets a point per sentence (pysbd, in the language lingua detects for the
  record), and one longer than `RAG_INDEX_MAX_BLOCK_CHARS` becomes overlapping 1,500
  character windows instead (a long table summary too). No point is longer than the
  embedding model reads in one input: llm-proxy says the model's limit (at most
  `RAG_EMBED_TOKEN_CEILING`, 8,191), text is counted with tiktoken's cl100k (times
  `RAG_EMBED_TOKEN_RATIO`, 2.13, for models with another tokenizer; text whose bytes fit is
  never counted), and longer text is cut on character boundaries into pieces that each fit,
  all on the same block. A model reading under 18 tokens fails the file with the reason.
  Points get a dense vector from the user's embedding model
  through llm-proxy (not charged) and a BM25 sparse vector computed here (fastembed), and go
  into RAG's own Qdrant collection for that model, `rag_<model>_<dims>` (never search's):
  `dense` and `sparse` vectors (IDF from Qdrant), int8 quantization, on-disk storage, and the
  user, content, revision, block, kind, text and citation in the payload. Point ids hash the
  content, revision, block and text, so retries overwrite; a new revision is written before
  the old one's points are deleted, and deleting content deletes its points. The content is
  then `completed`.
- **Big files and crashes.** Points are embedded and written `RAG_INDEX_WRITE_BATCH` (512) at a
  time, each batch durable before the next. Before the first one, the content records a marker:
  its revision, collection, embedding setup and a digest of the point ids it needs. A retry of
  that same revision with the same setup and points keeps the points that exist and embeds the
  rest, then checks every one is there; anything else embeds everything. The marker is cleared
  when the content completes or fails. After each index a stray sweep lists the content's
  points (at most `RAG_STRAY_SWEEP_MAX_POINTS`, 100,000, per run; the next run resumes where it
  stopped) and deletes those its revision doesn't have, such as points left by a crash between
  the write and the old revision's delete, or text that a changed setting split differently.
  Title and summary points are left to their owners, and a failed sweep never fails the index.
- **Retrieval.** `POST /rag/retrieve` (`{query, limit, sourceIds, sourceTypes, recordIds,
maxChunksPerRecord, createdAfter, createdBefore, modifiedAfter, modifiedBefore}`) and
  `/internal/rag/retrieve` (with `userId`, for the agent service).
  The query is embedded with the user's model and BM25; Qdrant searches both and fuses them
  by rank. Hits become passages: a list item brings its list, table rows gather under their
  table's summary, a hit on a small table (up to 250 cells) brings all of it, and the
  paragraphs either side fill any room left. Each passage names its record and where it is
  (page, sheet, row, heading path, blocks). `GET /rag/records/{id}/read?start=&max=` returns
  a record's blocks in order, 200 at a time, with `next` to continue, for reading a whole
  document or table. With `query`, a record that fits `RAG_FOCUSED_READ_CHARS` (16,000) comes
  whole; a longer one gives its opening, then the blocks matching the question (from a search
  limited to it) with their neighbours, grown outward to fill the room, in order, and `gaps`
  naming what was left out.
- **What a search couldn't see.** The response carries `unindexed` (records whose names match
  but whose content can't be searched yet), `incomplete` when part of the search didn't run
  (the name lookup failed), and `notices` (`STILL_READING`: records still being read;
  `DATES_PENDING`: records not yet searchable by date). Qdrant down or too slow is a 503
  (`SEARCH_INDEX_UNREACHABLE` / `SEARCH_INDEX_TIMEOUT`), never an empty result.
- **Dates.** Every record has a created and a modified date (an email's: when it was received;
  an attachment's: its email's; an upload's: the file's last-modified time the uploader sends
  as `lastModified`, one per file in ms, else when it was uploaded), and every point carries
  the dates of the records holding its content, so date bounds filter inside Qdrant's search.
  A bound is `YYYY-MM-DD` (the whole day, UTC) or a datetime with its zone; a reversed range
  or an "after" in the future is a 400. Records' changes reach their points at once, and a
  sweep (`RAG_UPKEEP_SWEEP_S`) catches up any that failed. Each record says where its dates
  came from (`dateOrigin`: source, lastModified, upload or content), and every passage's record
  carries `dates` (created, modified, origin).
- **What the dates left out.** Bounds match when a record was written or last changed, not when
  what it describes happened, so a retrospective written in April about March is left out of
  a March search. A search with dates therefore also runs once without them (10 results,
  beside the dated one) and returns `outsideDates`: up to 3 records the bounds left out, 3
  passages each, under a note saying so. A record already returned, or one inside the
  bounds that only ranked lower, is never listed; if that search fails, the result is as it
  would have been. `RAG_DATE_SAFETY_NET=false` turns it off.
- **Dates an upload states.** With `RAG_CONTENT_DOCUMENT_DATES` (`off` by default; `true`
  replaces only the upload time, `all` the file's last-modified time too), an upload takes the
  dates its header states once indexed: labelled lines ("Date:", "Sent:", "Created:",
  "Last updated:") in its first 8 prose blocks or 1,500 characters, plus a thread's later
  "From:" headers for when it last changed. A date the text only mentions, a label for another
  event ("Due date:"), a range, a slashed date that reads two ways, a date after the upload,
  a header giving two days, and a file last modified before the stated day all leave the
  upload's dates alone. Those are kept beside it and put back when the header no longer
  dates it or the setting is turned off. While it is on, an upload dated only by when it was
  uploaded counts as undated: it was written then or earlier, so a lower bound can leave it
  out but an upper bound doesn't (its points carry `uploadedAt` for that).
- **Titles.** Every record gets a title point the moment it is made, before its content is
  read: an email's header (subject, sender, recipients, date, attachment names), else its name.
  "The email from Ana" or "the budget sheet" then finds it though its text never says so. A
  title hit on a read record returns it whole up to `RAG_TITLE_HIT_WORDS` (700) words, else
  its opening and a note to read the rest; body hits inside what it shows fold into it. A
  name search above a cosine floor (`RAG_TITLE_MIN_SCORE`, 0.45) lists records whose content
  isn't searchable yet under `unindexed`.
- **Summaries.** Once a content is searchable, its `rag-classify` job sends it to the user's
  model through llm-proxy (`summarize`, cached and billed): a header with the record's name and
  type (`FILE` or `MAIL`), then its text blocks, table-row sentences and code in order, up to
  85% of `RAG_CLASSIFY_CONTEXT_TOKENS` (128,000) counted with cl100k. The instructions go
  alone as the system message, so every call shares a cached prefix. The answer is a
  category, subcategories, languages, topics, organizations and a retrieval-facing summary
  whose first sentence states the document's type, subject, parties and period (under 400
  words). When no answer fits that schema, a plain summary is asked for instead; when the model
  is down the job retries, and out of credits it gives up. The summary becomes a `summary`
  point of the content (found as `kind: "summary"`, cited as the whole record); the rest is
  shown on `GET /rag/records/{id}` with `classifyStatus`. Every content is handled the same
  way, mail or file; a .log or .cfg is not sent, nor content with no text.
  `RAG_CLASSIFY=false` turns it off; `RAG_CLASSIFY_ON_FIRST_USE` waits until a search first
  returns the content. A failure never touches the record's own status.
- **Each user's settings.** `GET /rag/settings` returns the user's settings and the server's
  defaults they start from (`RAG_*` env), and whether summaries are available on this server;
  `PUT` saves them whole, `DELETE` goes back to the defaults. Search: `results` (8),
  `maxPerRecord`, `dateSafetyNet`; a retrieve without `limit` uses them. Indexing:
  `summaries` (`on`, `first_use`, `off`), `headerDates` (`off`, `true`, `all`),
  `windowChars` and `windowOverlap`, applied to files indexed from then on. A server switch
  still wins: with `RAG_CLASSIFY=false` nobody's files are summarized.
- **Records table.** `GET /rag/records` pages the user's records (`offset`, `limit` up to 100)
  with filters (`q` part of the name, `status`, `sourceType`, `sourceId`, `mimeType`, each
  repeatable; `minSize`/`maxSize`; `createdAfter`/`createdBefore`/`modifiedAfter`/
  `modifiedBefore` on the record's own dates) and `sort` (`createdAt`, `updatedAt`,
  `sourceCreatedAt`, `sourceModifiedAt`, `name`, `sizeBytes`) with `order`; it returns `total`
  and the statuses and file types the user has, with counts. `POST /rag/records/reindex`
  (`ids`, up to 100) reads settled records' files again as a new revision (a record being
  read is skipped, with why); the record is out of search until that revision is indexed.
- **Sources and files.** `GET /rag/sources` lists the user's knowledge bases and mail accounts
  with their record counts per status and when the last record arrived;
  `GET /rag/records/{id}/file` returns a record's original bytes (an email as its .eml).
- **Mail.** The mail service follows its stored mail (a MongoDB change stream: every email
  once, then each change) and puts a job per email on `rag-mail`; RAG reads the email and its
  attachments back from mail's `/internal` routes. An email is one record whichever folders
  hold copies of it (spam, trash and drafts are left out), named by its subject, its content
  the latest reply only: quoted history is removed with talon, as earlier emails of the thread
  hold it, but a forward is kept whole. Each attachment is a child record. A copy moved or
  deleted updates the record; once no readable copy is left, the email and its attachments
  leave RAG. Passages from mail carry the sender, recipients and date, and an attachment's
  carry its email's.
- **Formats so far:** plain text and Markdown (markdown-it), HTML (selectolax), email (attachments become child records),
  JSON and JSON Lines, YAML, CSV and TSV, spreadsheets, PDF, Word, PowerPoint, EPUB books,
  images (PNG, JPEG, WebP, TIFF, BMP, GIF, HEIC/HEIF, AVIF, and SVG drawn with cairo after its
  size, depth and references are checked), and other text. Pictures inline in HTML are kept
  and described. A DRM-protected book is reported as password-protected.
- **SVG on macOS:** cairosvg needs cairo (`brew install cairo`); it is found through
  `HOMEBREW_PREFIX`, which Homebrew's shell setup sets. The image installs `libcairo2`.

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
