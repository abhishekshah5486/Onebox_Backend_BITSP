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
- Not in scope: connectors, the knowledge graph, entity resolution, agents and chat.

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

1. **Ingest:** record created, real type from magic bytes, size caps, zip-bomb and encryption
   checks; original stored; parse job queued.
2. **Inspect and route:** inspection and an engine decision, as PipesHub does, recorded per
   revision.
3. **Parse:** the engine per the table above, in sandboxed worker processes with time, memory
   and page caps (PipesHub's parse pool is the model).
4. **Enrich:** image descriptions, sheet summaries and row sentences, heading paths, a summary
   block per record.
5. **Chunk:** structure-aware within token limits; tables as summary plus rows; chunks keep
   their block ids for citations.
6. **Embed and index:** dense through llm-proxy, BM25 sparse locally; Qdrant named vectors with
   payload `userId`, `sourceId`, `recordId`, `blockIds`, `page`; content fingerprints skip
   unchanged chunks; re-index builds then swaps.
7. **Retrieve:** `/internal/rag/retrieve` (and `POST /rag/query` for testing): hybrid dense and
   sparse with fusion, filters, top-k, source diversity, neighbour blocks, optional rerank,
   token-budget packing, citations.

Progress (`queued → parsing → indexing → ready | failed`) goes out on the realtime channel.

## Choices per step

Every pluggable step sits behind one interface with several providers, picked in a per-user
`rag_config` (UI later). PipesHub offers OCR provider, embedding provider and vector database
choices; we offer those and a few more:

| Step                           | Choices                                                                                                                                 | Default                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Scanned pages and images (OCR) | Vision-model OCR (any multimodal model in llm-proxy), Azure Document Intelligence, Docling's local OCR (RapidOCR or Tesseract, offline) | Vision-model OCR                    |
| Digital documents              | Docling, or pdfplumber + OpenCV only                                                                                                    | Docling, falling back automatically |
| Image descriptions             | Any multimodal model in llm-proxy, or off                                                                                               | user's AI model                     |
| Spreadsheet rows               | LLM row sentences, or plain "header: value" rows (no model calls)                                                                       | LLM row sentences                   |
| Embedding model                | Any embedding model in llm-proxy (hosted, own key, or local through Ollama)                                                             | user's semantic-search model        |
| Vector store                   | Qdrant, pgvector (both hybrid-capable); more later                                                                                      | OneBox Qdrant                       |
| Chunking                       | Max tokens, overlap                                                                                                                     | 512, 64                             |
| Retrieval                      | Top-k, hybrid on or off, fusion (RRF or weighted)                                                                                       | 8, on, RRF                          |
| Reranker                       | Off, local cross-encoder (bge-reranker), Cohere, Voyage, Jina                                                                           | off                                 |

## Milestones (small commits, each with tests)

1. Service skeleton: FastAPI, health, auth, config, Docker image (LibreOffice, Docling models),
   turbo scripts, CI job, README crediting PipesHub as the reference.
2. Block model and records in MongoDB; blob storage; ingest queue.
3. Light parsers (text, HTML, Markdown, EML, JSON, YAML, CSV).
4. Sandboxed parse pool, PDF inspection and engine routing.
5. Docling service and the Docling path for PDF, DOCX and PPTX; LibreOffice conversion.
6. pdfplumber + OpenCV fallback.
7. llm-proxy image input; VLM OCR for scans; image descriptions.
8. Spreadsheets with header detection, summaries and row sentences.
9. Chunking, dense and sparse embeddings, RAG vector store settings, hybrid indexing.
10. Retrieval, packing, citations, optional reranker.
11. Mail source: backfill and live feed of all mail and attachments.
12. Evaluation corpus (every format, questions with expected passages, recall@k and MRR in CI)
    and hardening (retries, dead letters, metrics).

Tests: pytest with Testcontainers (MongoDB, Redis, Qdrant) and fixture files for every format (digital, scanned and
tabled PDFs, DOCX, PPTX, DOC, XLSX, CSV, images, SVG, HTML, EML).
