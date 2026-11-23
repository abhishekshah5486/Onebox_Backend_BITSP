# RAG service plan

The knowledge layer for automated replies (part 2). A separate service that ingests the user's
documents and mail, and returns grounded passages with citations for the reply drafter.

Reference: [PipesHub](https://github.com/pipeshub-ai/pipeshub-ai) (Apache-2.0), read at commit
`cba95ad` (2026-11-23). We follow its pipeline design and may adapt code with attribution in a
`NOTICE` file; we do not copy its connectors, graph or agent layers.

## What PipesHub does that we keep

| Stage          | PipesHub                                                                                                                                                                       | OneBox RAG                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Parse          | Docling for PDF/DOCX/PPTX/HTML; pdfplumber + OpenCV table detector; OCR and VLM OCR for scans; openpyxl/pandas for sheets; per-format parsers (csv, md, json, eml, epub, code) | Same libraries, same fallbacks                                     |
| Document model | Typed **blocks** (text, heading, list, table, table_row, image, code) with page and bbox provenance                                                                            | Same block model, trimmed to what we use                           |
| Enrich         | Image blocks get a written description; sheets get LLM summaries; tables are kept as rows with headers                                                                         | Same, through llm-proxy so the user's own models and credits apply |
| Isolation      | Untrusted files parse in worker processes with limits; worker deaths are recorded                                                                                              | Same: subprocess per parse, time, memory and page caps             |
| Index          | Dense vectors plus BM25 sparse vectors (fastembed) in Qdrant; content fingerprints skip unchanged blocks                                                                       | Same, one hybrid collection per embedding model                    |
| Retrieve       | Hybrid search, result merging, source diversity, neighbour blocks, citations                                                                                                   | Same, plus an optional cross-encoder rerank                        |

## Service shape

- **Language: Python 3.13, FastAPI.** The parsing stack (Docling, pdfplumber, OpenCV, OCR,
  sentence-transformers, fastembed) exists at this quality only in Python. The rest of OneBox
  stays TypeScript; the service talks to it through HTTP and the same Redis queues.
- Lives at `services/rag`, managed with `uv`, every dependency pinned to an exact version at
  least two weeks old. Turbo runs it like the others (`dev`, `test`, `lint` scripts in its
  `package.json` call `uv run …`).
- **Queues:** BullMQ's official Python client (`bullmq`), so jobs use the same Redis and
  envelope shape as the TypeScript services.
- **Auth:** user requests verified against the auth service's JWKS (as `auth-kit` does);
  service-to-service calls use the existing internal token.
- **Storage:** originals in the existing blob store; documents, blocks and jobs in MongoDB
  (`onebox_rag`); vectors in Qdrant.
- **Models:** embeddings and LLM calls (image descriptions, sheet summaries) go through
  llm-proxy, so the user's chosen and BYOK models apply, with credits. BM25 sparse vectors and
  the optional local reranker run in the service (CPU).

## Pipeline

1. **Ingest.** `POST /rag/documents` (multipart upload, into a knowledge base) or an internal
   call for mail attachments. Checks real type from magic bytes, size caps, zip bombs and
   encrypted files. Stores the original, records the document as `queued`, enqueues a parse job.
2. **Parse** (worker subprocess, limits per file):
   - PDF: Docling layout; digital text first, OCR (RapidOCR, CPU) for scanned pages; pdfplumber
     - OpenCV for tables Docling misses; optional vision-model OCR for hard pages.
   - DOCX, PPTX, HTML, Markdown: Docling, with python-docx / BeautifulSoup fallbacks.
   - EPUB: unpacked to its HTML chapters, then the HTML path.
   - XLSX, XLS, CSV: openpyxl / pandas into tables, one block per row with its headers.
   - Images (PNG, JPG, WEBP, TIFF, HEIC): OCR text plus a vision-model description.
   - EML: headers and body as text; attachments become their own documents.
   - TXT, JSON, YAML, code: text blocks with format-aware splitting.
3. **Enrich.** Image descriptions, table and sheet summaries, a short document summary, and the
   heading path stored on every block for context.
4. **Chunk.** Structure-aware: by section, capped by tokens with overlap; tables as a summary
   chunk plus row chunks; every chunk keeps the block ids it came from for citations.
5. **Embed and index.** Dense through llm-proxy, sparse BM25 locally; Qdrant named vectors
   (`dense`, `sparse`) with payload `userId`, `kbId`, `documentId`, `blockIds`, `page`. Chunks
   keyed by content hash, so re-ingesting only embeds what changed; a re-index builds the new
   version, then swaps.
6. **Retrieve.** `POST /rag/query` and internal `/internal/rag/retrieve`: hybrid query (dense
   and sparse prefetch, RRF fusion in Qdrant), filters (user, knowledge base, documents),
   top-k, source diversity, optional rerank, neighbour-block expansion, packing to a token
   budget, citations (document, page, block).

Status events (`queued → parsing → indexing → ready | failed`) go out on the realtime channel.

## Configuration (designed now, exposed later)

One `rag_config` per user with defaults, so each step can get a settings screen later without
changing the pipeline:

| Step     | Setting                                                               | Default                                     |
| -------- | --------------------------------------------------------------------- | ------------------------------------------- |
| Parse    | OCR on scans, vision-model OCR, image descriptions                    | on, off, on                                 |
| Chunk    | Max tokens, overlap                                                   | 512, 64                                     |
| Embed    | Embedding model                                                       | user's semantic-search model                |
| Store    | Vector store                                                          | OneBox Qdrant (hybrid needs sparse support) |
| Retrieve | Top-k, hybrid on/off, fusion                                          | 8, on, RRF                                  |
| Rerank   | Off, local cross-encoder, or a hosted reranker (Cohere, Voyage, Jina) | off                                         |

## Milestones (small commits, each with tests)

1. Service skeleton: FastAPI, health, auth, config, Docker image, turbo scripts, CI job.
2. Knowledge bases and documents API, blob storage, MongoDB records, parse queue.
3. Block model and parsers for text formats, HTML, Markdown, CSV and XLSX.
4. Docling parsing for PDF, DOCX and PPTX in sandboxed workers.
5. OCR for scans and images; table fallbacks; vision-model descriptions.
6. Chunking, dense and sparse embeddings, Qdrant hybrid indexing, content-hash skips.
7. Retrieval: hybrid query, diversity, neighbours, packing, citations; optional reranker.
8. Evaluation set (a fixture corpus of every format, with questions and expected passages;
   recall@k and MRR in CI) and hardening (retries, dead letters, limits, metrics).
9. Mail attachments as a source; then the reply drafter uses `/internal/rag/retrieve`.

Tests: pytest with Testcontainers (MongoDB, Redis, Qdrant), fixture documents for every format
(digital PDF, scanned PDF, PDF with tables, DOCX, PPTX, XLSX, CSV, images, HTML, EML).

## Costs and limits on this machine

Docling and OCR bring PyTorch on CPU (an image of a few GB, models downloaded once). Parsing
runs one file at a time by default; tests use small fixtures and one worker.
