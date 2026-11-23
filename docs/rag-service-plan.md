# RAG service plan

The knowledge layer for automated replies (part 2). A separate service that ingests all of the
user's mail and mail attachments (and later external sources), and returns grounded passages
with citations for the reply drafter.

## Reference: PipesHub, as inspiration

[PipesHub](https://github.com/pipeshub-ai/pipeshub-ai) (Apache-2.0, read at commit `cba95ad`,
2026-11-23) is the model for this service: its module layout, its routing of each file to the
right engine, its block model and its hybrid index. We write our own code following that
structure and approach; we do not copy its files.

- We mirror its layout: `parsers/<format>`, `parse_engine` (inspection, cost, engine choice),
  `transformers` (enrich, embed, index), `retrieval`, and a provider factory per pluggable step.
- Like PipesHub, each pluggable step offers several providers behind one interface, chosen in
  settings (see Choices).
- Their seams are OneBox's here: settings service instead of etcd, llm-proxy instead of their
  LLM gateway, our blob store, MongoDB instead of ArangoDB/Neo4j, BullMQ instead of Kafka.
- Not in scope here: connectors, the knowledge graph and entity resolution. Agents and chat live
  in their own service (see Agent service below), which calls RAG like any other client.

## How PipesHub ingests multimodal documents

Built-in OCR libraries are not what makes it robust. It routes every file by an inspection
step, then sends anything hard to a **vision language model (VLM)**:

| Input                                       | What PipesHub does                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing                                     | A sandboxed worker inspects the file first (`pdf_inspection`): page count, text layer; a PDF is "scanned" when at least half of up to 30 sampled pages need OCR. A cost estimate picks one engine per revision and records it, so retries never re-decide (`parse_engine`).                                                             |
| Digital PDF                                 | **Docling**, run as its own service with OCR **off**, TableFormer for table structure, page images kept. Concurrency adapts (429 halves it), with a deadline per document.                                                                                                                                                              |
| Large PDF, or Docling down                  | **pdfplumber + OpenCV** layout analyser on CPU (their own, about 5.8k lines): reading order, columns, table detection.                                                                                                                                                                                                                  |
| Scanned PDF                                 | **VLM OCR**: each page rendered at 200 DPI and sent to a multimodal LLM with a markdown prompt (headings, lists, tables as markdown tables, figures as `{{IMAGE: description}}`). Cached per page render, model and prompt; retries; truncation detected; capped at 500 pages. Azure Document Intelligence is the alternative provider. |
| DOC, PPT                                    | Converted by LibreOffice to DOCX / PPTX, then the Docling path.                                                                                                                                                                                                                                                                         |
| DOCX, PPTX                                  | Docling's converter for each format.                                                                                                                                                                                                                                                                                                    |
| XLSX, XLS, CSV                              | Tables read with openpyxl / pandas; an LLM finds the header rows, summarises the sheet and writes a natural-language sentence per row (batched, keyed). Each row is a `table_row` block.                                                                                                                                                |
| Images, SVG                                 | Image blocks (SVG rasterised with cairosvg); a multimodal LLM writes a description, which is what gets embedded and searched.                                                                                                                                                                                                           |
| HTML, Markdown, EML, JSON, YAML, text, code | Dedicated light parsers, run inline.                                                                                                                                                                                                                                                                                                    |

Everything becomes typed **blocks** (text, image, table_row, code, with page and bbox), which are
embedded as dense vectors plus BM25 sparse vectors in Qdrant.

## Service shape

- **Python 3.13, FastAPI**, at `services/rag`, managed with `uv`; every dependency pinned to
  an exact version at least two weeks old.
  Turbo runs it like the other services (`uv run …` behind its `package.json` scripts).
- Separate processes, as in PipesHub: the API, the ingest worker, and the **Docling service**
  (its own process with its own limits). Heavy is fine: PyTorch on CPU, LibreOffice and models
  in the image.
- **Queues:** BullMQ's Python client, same Redis and job envelope as the TypeScript services.
- **Auth:** JWTs checked against the auth service's JWKS; internal calls use the internal token.
- **Storage:** originals in the existing blob store; records, blocks and job state in MongoDB
  (`onebox_rag`).
- **Models through llm-proxy:** embeddings, VLM OCR, image descriptions and sheet summaries, so
  the user's chosen and own-key models apply, with credits. llm-proxy gains image input (a
  `vision` purpose) for this. BM25 sparse vectors and an optional local reranker run in-service.

## Its own vector stores, separate from semantic search

The indexing stores in Settings (OneBox hosted, Milvus, Pinecone…) serve search inside OneBox
only. RAG never reads or writes them:

- Its own settings: `rag_vector_stores` (and the user's choice of one), not `indexing_stores`.
- Its own collections, named `rag_<model>_<dims>`, on OneBox's Qdrant by default; Qdrant first
  because hybrid search needs sparse vectors.
- These stores are the ones that will later hold external sources (Drive, Notion, and so on)
  too.

## Sources

The data model is source-agnostic from the start, so external connectors slot in later:
**source** (a mail account, uploads, later Drive and others) → **record** (an email, a file) →
**blocks** → **chunks**.

- **All mail:** every stored message, every folder but Spam and Trash, one record per email
  (keyed by account and Message-ID, as search does). The mail service feeds it like the search
  feed: a backfill once, then new mail from its change stream.
- **All attachments:** each one is its own record linked to its email, fetched through the
  existing "copy message source to blob" connector op, then parsed by type.
- Deleted or moved mail updates or removes its records.

## Pipeline

1. **Ingest.** Records come from the mail source (every email and attachment), from
   `POST /rag/documents` (multipart upload into a knowledge base), and later from external
   sources. Each one: real type read from its bytes (magic bytes, and the declared type inside
   ZIP containers: OOXML's `[Content_Types].xml`, EPUB's and ODF's `mimetype`); size caps; zip
   bombs (unpacked size, ratio, entry count) and encrypted files recorded as `rejected` with a
   reason; the same content in the same source reuses its record; the original stored in the
   blob store; the record saved as `queued`; a parse job enqueued (BullMQ, the TypeScript job
   envelope, one job per record revision).
2. **Inspect and route.** A sandboxed worker inspects the file (page count, text layer, scanned
   share of sampled pages) and picks one engine per revision, recorded so retries, replays and
   re-indexes never re-decide (PipesHub's PDF inspection and cost-based engine choice are the
   model).
3. **Parse** in sandboxed worker processes with time, memory and page caps per file (PipesHub's
   parse pool is the model), each engine with a fallback:
   - **PDF:** Docling layout for digital text (its own OCR off, TableFormer for tables, page
     images kept); scanned pages through the OCR provider (default: a free local model, see
     Choices); pdfplumber + OpenCV for tables Docling misses and for PDFs over Docling's limits
     or while it is down; vision-model OCR for pages the rest cannot read.
   - **DOCX, PPTX, HTML, Markdown:** Docling, with python-docx / BeautifulSoup fallbacks.
   - **DOC, PPT:** converted by LibreOffice to DOCX / PPTX first.
   - **EPUB:** unpacked to its HTML chapters, then the HTML path. **Done**: spine order, the
     book's pictures inlined, DRM books reported as protected.
   - **XLSX, XLS, CSV:** openpyxl / pandas into tables, header rows found, one block per row with
     its headers.
   - **Images (PNG, JPG, WEBP, TIFF, HEIC, SVG):** OCR text plus a vision-model description; SVG
     rasterised first. **Done**, with AVIF; SVG checked for size, depth and reference
     expansion before cairo draws it; pictures inline in HTML kept and described.
   - **EML:** headers and body as text; its attachments become their own records.
   - **TXT, JSON, YAML, code:** text blocks with format-aware splitting.
4. **Enrich.** Image descriptions, table and sheet summaries, a sentence per spreadsheet row, a
   short summary block per record, and the heading path stored on every block for context.
5. **Chunk.** Structure-aware: by section, capped by tokens with overlap; tables as a summary
   chunk plus row chunks; every chunk keeps the block ids it came from, for citations.
6. **Embed and index.** Dense vectors through llm-proxy, BM25 sparse vectors locally; Qdrant
   named vectors (`dense`, `sparse`) with payload `userId`, `sourceId`, `recordId` (and `kbId`
   for uploads), `blockIds`, `page`. Chunks keyed by content hash, so re-ingesting only embeds
   what changed; a re-index builds the new version, then swaps.
7. **Retrieve.** `POST /rag/retrieve` (signed-in user) and `/internal/rag/retrieve` (other
   services, for a given user), as PipesHub's retrieval does it:
   - The query is embedded twice: the user's dense model and BM25. Qdrant runs both legs (each
     `2 × limit` deep, the dense leg rescoring int8 hits at full precision with 1.5×
     oversampling and `hnsw_ef` 256), fuses them with RRF, and ties are broken by id so the
     same query always ranks the same. Filters: always the user; optionally knowledge bases,
     sources or records.
   - Optional record cut (off by default, as there): fetch 3× deeper, then keep at most
     `max(4, limit / 6)` hits per record in the first half and give the rest to records not
     yet represented, so one long file can't fill the page.
   - Hits become units the model reads: a paragraph is itself; a list item brings its whole
     list; table rows are gathered under their table (summary plus the matched rows, in table
     order); a hit on a table's own point brings the whole table when it is small (≤ 250
     cells), its summary otherwise. A block hit several ways (whole, sentence, window) keeps
     its best score.
   - Units are ranked by score and cut to the limit; spare room goes to the paragraph just
     before and after each unit (around the whole table for a table), never taking a slot from
     a real hit.
   - Each chunk carries its record (id, name, type, knowledge base) and citation (page, sheet,
     row, slide, line, heading path, block index); `maxChunksPerRecord` caps one record.
   - Reading a record in pages: `/rag/records/{id}/read?start=&max=` returns blocks in order
     (200 per page by default) with where to continue, for agents that need a whole document
     or table (an average over every row, say).
   - No reranker: PipesHub has none in retrieval either; one can be added behind a setting if
     the evaluation set shows it helps. Packing passages into a token budget happens where the
     prompt is built, in the agent service.

Progress (`queued → parsing → indexing → ready | failed`) goes out on the realtime channel.

## Agent service (separate)

Agents and chat are a service of their own (`services/agent`), not part of RAG, so the same
loop serves the reply drafter now and a chat over the user's own documents in the web app
later (upload files, ask questions, get answers with citations). It follows PipesHub's agent
loop:

- **Loop:** a ReAct loop over the user's model through llm-proxy (tool calls), with a quick
  mode for chat (retrieval prefetched in parallel with building the agent, so simple questions
  answer in one turn with no tool call) and a plan-and-execute mode for longer tasks.
- **Knowledge tools:** `search_knowledge` (RAG retrieve), `fetch_full_record` (RAG's paged
  record read, with a continuation hint, for whole documents and tables), and later
  `search_mail` (OneBox's own search).
- **Exact numbers:** `evaluate_expression`, `date_difference`, `count_text` for any calculation
  of more than one step; a locked-down Python sandbox (`run_code`) for aggregations over data,
  such as averages over a table's rows.
- **Answers:** citations to the chunks used (record, page, block), packing passages into the
  model's token budget, images to multimodal models.
- **Modes:** chat (internal search only), and the reply drafter (an email in, a draft with
  sources out; autonomy rules decide whether it is sent).
- **Streaming:** answers and tool progress over SSE, like PipesHub's `/chat/stream`.

Built after RAG's retrieval (milestone 10) and the mail source (11), as milestones A1–A4:
A1 service skeleton and the loop with `search_knowledge` + `fetch_full_record`; A2 calculator
tools and citations; A3 chat API with streaming and history; A4 the reply drafter. The code
sandbox comes after A4.

## Choices per step

Every pluggable step sits behind one interface with several providers, picked in a per-user
`rag_config` (UI later). PipesHub offers OCR provider, embedding provider and vector database
choices; we offer those and a few more:

| Step                                           | Choices                                                                                                                                                                 | Default                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Scanned pages and images (OCR)                 | A free local model (a vision model served by Ollama, or RapidOCR through Docling), vision-model OCR with any multimodal model in llm-proxy, Azure Document Intelligence | A free local model                  |
| Digital documents                              | Docling, or pdfplumber + OpenCV only                                                                                                                                    | Docling, falling back automatically |
| Image descriptions                             | Any multimodal model in llm-proxy, or off                                                                                                                               | user's AI model                     |
| Spreadsheet rows                               | LLM row sentences, or plain "header: value" rows (no model calls)                                                                                                       | LLM row sentences                   |
| Embedding model                                | Any embedding model in llm-proxy (hosted, own key, or local through Ollama)                                                                                             | user's semantic-search model        |
| Vector store                                   | Qdrant, pgvector (both hybrid-capable); more later                                                                                                                      | OneBox Qdrant                       |
| Chunking                                       | Max tokens, overlap                                                                                                                                                     | 512, 64                             |
| Retrieval                                      | Top-k, hybrid on or off, fusion (RRF or weighted)                                                                                                                       | 8, on, RRF                          |
| Reranker (later, if evaluation shows it helps) | Off, local cross-encoder (bge-reranker), Cohere, Voyage, Jina                                                                                                           | off                                 |

## Milestones (small commits, each with tests)

1. Service skeleton: FastAPI, health, auth, config, Docker image, turbo scripts, gateway route,
   k8s deployment, CI job, README crediting PipesHub as the reference. **Done.**
2. Block model and records in MongoDB; blob storage; ingest queue; upload and record routes.
   **Done.**
3. PipesHub's block model (blocks, block groups, citation metadata), status set and shared
   content per set of bytes; OpenDocument and OOXML password detection; light parsers (text,
   HTML, Markdown, EML, JSON, YAML, CSV) and the parse worker. **Done.**
4. Sandboxed parse pool, PDF inspection and engine routing. **Done.**
5. Docling service and the Docling path for PDF, DOCX and PPTX; LibreOffice conversion (both
   in a separate Docling image, as PipesHub runs it). **Done.**
6. pdfplumber + OpenCV fallback. **Done.**
7. OCR providers (free local model first, then llm-proxy image input for vision-model OCR and
   Azure DI); image descriptions. **Done** with RapidOCR (default) and any OpenAI-compatible
   vision model; Docling's own OCR behind a setting, off. Per-user provider settings and Azure
   DI come later.
8. Spreadsheets with header detection, summaries and row sentences. **Done**: CSV, XLSX/XLSM
   (openpyxl), XLS/ODS/XLSB (LibreOffice in the Docling service); every table, from any
   format, enriched through llm-proxy.
9. Chunking, dense and sparse embeddings, RAG vector store settings, hybrid indexing. **Done**:
   block-level points (sentences and windows for long blocks, a point per table), the user's
   embedding model through llm-proxy plus BM25, RAG's own `rag_<model>_<dims>` Qdrant
   collections. Per-user store and model choices come with the settings UI.
10. Retrieval: hybrid search, units (lists, tables, small tables whole), neighbours,
    citations, paged record reads. **Done**: `POST /rag/retrieve`, `/internal/rag/retrieve`, and
    `/rag/records/{id}/read` (plus its internal twin) for the agent service's tools.
11. Mail source: backfill and live feed of all mail and attachments. **Done**: the mail service's change
    feed (shared with search) puts a job per email on `rag-mail`; RAG reads it back through
    mail's `/internal/messages` routes; latest reply only (talon, forwards kept whole); spam,
    trash and drafts left out; attachments as child records; sender, recipients and date on
    every passage.
    11a. Email header points and date filters. **Done**: a header point per email (subject,
    people, date, attachment names), returning the email whole when short and its opening when
    long; created/modified date bounds on retrieval, as dates on every point (one Qdrant range
    filter, the dates kept in step with the records by an upkeep step and a sweep), with the
    reference's rules for reading a bound. Upload dates stated in the content come later.
12. Evaluation corpus (every format, questions with expected passages, recall@k and MRR in CI)
    and hardening (retries, dead letters, metrics).

Tests: pytest with Testcontainers (MongoDB, Redis, Qdrant) and fixture files for every format (digital, scanned and
tabled PDFs, DOCX, PPTX, DOC, XLSX, CSV, images, SVG, HTML, EML).
