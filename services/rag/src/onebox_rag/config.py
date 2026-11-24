import base64
import binascii
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BeforeValidator, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from onebox_rag.pipeline.pool import default_workers

# The repo's shared .env, two levels above the service, like the TypeScript services read it.
ROOT_ENV = Path(__file__).resolve().parents[4] / ".env"


def _decode_key(value: object) -> bytes:
    if isinstance(value, bytes):
        key = value
    else:
        try:
            key = base64.b64decode(str(value), validate=True)
        except binascii.Error as err:
            raise ValueError("must be base64") from err
    if len(key) != 32:
        raise ValueError("must decode to exactly 32 bytes")
    return key


EncryptionKey = Annotated[bytes, BeforeValidator(_decode_key)]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore", frozen=True)

    PORT: int = Field(default=4012, ge=1, le=65535)
    HOST: str = "0.0.0.0"  # noqa: S104 - served behind the gateway, like the other services
    LOG_LEVEL: Literal["debug", "info", "warning", "error"] = "info"
    MONGO_URI: str = Field(min_length=1)
    MONGO_DB: str = "onebox_rag"
    REDIS_URL: str = Field(min_length=1)
    AUTH_SERVICE_URL: str = "http://localhost:4001"
    CREDENTIALS_ENCRYPTION_KEY: EncryptionKey

    # The S3-compatible store the other services use (SeaweedFS locally), own bucket.
    BLOB_ENDPOINT: str = "http://localhost:8333"
    BLOB_REGION: str = "us-east-1"
    BLOB_ACCESS_KEY: str = Field(min_length=1)
    BLOB_SECRET_KEY: str = Field(min_length=1)
    RAG_BLOB_BUCKET: str = Field(default="onebox-rag", min_length=3)

    RAG_INGEST_QUEUE: str = "rag-ingest"
    # Index jobs (embedding and writing points) run apart from parsing: they wait on the network.
    RAG_INDEX_QUEUE: str = "rag-index"
    RAG_INDEX_CONCURRENCY: int = Field(default=4, ge=1)
    # Points are embedded and written this many at a time; a retry of the same revision
    # embeds only the points still missing.
    RAG_INDEX_WRITE_BATCH: int = Field(default=512, ge=16, le=4096)
    # After each index, a content's points its revision no longer has are deleted: at most
    # this many are listed per run (0 turns the sweep off).
    RAG_STRAY_SWEEP_MAX_POINTS: int = Field(default=100_000, ge=0)
    # Once searchable, every content is classified and summarized by the user's model (its
    # summary becomes a point found as the whole record): right away, or with
    # RAG_CLASSIFY_ON_FIRST_USE when a search first returns it. A .log or .cfg is not.
    RAG_CLASSIFY: bool = True
    RAG_CLASSIFY_ON_FIRST_USE: bool = False
    RAG_CLASSIFY_QUEUE: str = "rag-classify"
    RAG_CLASSIFY_CONCURRENCY: int = Field(default=2, ge=1)
    # The model reads up to 85% of this many tokens of the content, from its start.
    RAG_CLASSIFY_CONTEXT_TOKENS: int = Field(default=128_000, ge=1000)
    RAG_CLASSIFY_MAX_OUTPUT_TOKENS: int = Field(default=2000, ge=256, le=32_000)
    # The mail source: the mail service feeds stored mail on rag-mail, and RAG reads each email
    # and its attachments back from it. An empty RAG_MAIL_URL leaves the queue unread.
    RAG_MAIL_URL: str = "http://localhost:4003"
    RAG_MAIL_QUEUE: str = "rag-mail"
    RAG_MAIL_CONCURRENCY: int = Field(default=4, ge=1)
    RAG_MAIL_TIMEOUT_S: float = Field(default=120, gt=0)
    RAG_INGEST_ATTEMPTS: int = Field(default=5, ge=1)
    RAG_INGEST_BACKOFF_MS: int = Field(default=5_000, ge=0)
    # Runs the parse worker inside the API process; off where it runs as its own deployment.
    RAG_RUN_WORKER: bool = True
    # Parse pool: worker processes (half the CPUs, at most 4), per-file time limit, memory cap
    # per worker (enforced on Linux), and how many files a worker parses before it is replaced.
    RAG_PARSE_WORKERS: int = Field(default_factory=default_workers, ge=1)
    RAG_PARSE_TIMEOUT_S: float = Field(default=600, gt=0)
    RAG_PARSE_MEMORY_MB: int = Field(default=4096, ge=0)
    RAG_PARSE_WORKER_MAX_JOBS: int = Field(default=200, ge=0)

    # PDF routing: scanned when this share of sampled pages needs OCR;
    # Docling up to these pages and bytes, pdfplumber past them.
    RAG_PDF_OCR_SAMPLE_PAGES: int = Field(default=30, ge=1)
    RAG_PDF_OCR_PAGE_SHARE: float = Field(default=0.5, gt=0, le=1)
    RAG_DOCLING_MAX_PAGES: int = Field(default=30, ge=1)
    RAG_DOCLING_MAX_MB: int = Field(default=100, ge=1)
    # The Docling service (PDF, Word, PowerPoint); empty leaves those files waiting for it.
    RAG_DOCLING_URL: str = "http://localhost:4013"
    RAG_DOCLING_TIMEOUT_S: float = Field(default=900, gt=0)

    # OCR for scanned PDFs and image files: "rapidocr" (free, local) or "vision" (the model
    # below; without one it falls back to rapidocr). Pages render at 200 DPI.
    RAG_OCR_PROVIDER: Literal["rapidocr", "vision"] = "rapidocr"
    RAG_OCR_DPI: int = Field(default=200, ge=72, le=600)
    RAG_OCR_MAX_PAGES: int = Field(default=500, ge=1)
    # An OCR job may run this long on top of RAG_PARSE_TIMEOUT_S for each page.
    RAG_OCR_SECONDS_PER_PAGE: float = Field(default=10, gt=0)

    # A vision model behind an OpenAI-compatible API, for vision OCR and picture descriptions:
    # a local Ollama by default; empty RAG_VISION_MODEL turns both off.
    RAG_VISION_BASE_URL: str = "http://localhost:11434/v1"
    RAG_VISION_MODEL: str = ""
    RAG_VISION_API_KEY: str = ""
    RAG_VISION_TIMEOUT_S: float = Field(default=360, gt=0)
    RAG_VISION_MAX_TOKENS: int = Field(default=4096, ge=256)
    RAG_VISION_CONCURRENCY: int = Field(default=10, ge=1)
    RAG_VISION_RETRIES: int = Field(default=2, ge=0)
    RAG_DESCRIBE_IMAGES: bool = True
    RAG_DESCRIBE_MAX_IMAGES: int = Field(default=60, ge=0)

    # Tables (spreadsheets and tables in documents): the user's model, through llm-proxy, finds
    # a sheet's header rows, summarizes each table and writes its rows as sentences, for up to
    # RAG_TABLE_LLM_ROWS rows per file; the rest keep "column: value" text. An empty
    # RAG_LLM_PROXY_URL or RAG_TABLE_ENRICHMENT=false leaves every table plain.
    RAG_LLM_PROXY_URL: str = "http://localhost:4006"
    RAG_LLM_TIMEOUT_S: float = Field(default=180, gt=0)
    RAG_TABLE_ENRICHMENT: bool = True
    RAG_TABLE_LLM_ROWS: int = Field(default=1000, ge=0)
    RAG_TABLE_ROW_BATCH: int = Field(default=50, ge=1, le=200)
    RAG_TABLE_CONCURRENCY: int = Field(default=8, ge=1)
    RAG_TABLE_MAX_OUTPUT_TOKENS: int = Field(default=8192, ge=256, le=32000)

    # Indexing: RAG's own collections on OneBox's Qdrant (an empty QDRANT_URL leaves parsed
    # content waiting to be indexed). Vectors come from the user's embedding model through
    # llm-proxy (RAG_LLM_PROXY_URL), BM25 sparse vectors from here.
    QDRANT_URL: str = "http://localhost:6333"
    QDRANT_API_KEY: str | None = None
    QDRANT_TIMEOUT_S: float = Field(default=60, gt=0)
    RAG_EMBED_CONCURRENCY: int = Field(default=4, ge=1)
    RAG_EMBED_TIMEOUT_S: float = Field(default=120, gt=0)
    # A block longer than this is embedded as windows of RAG_INDEX_WINDOW_CHARS (overlapping
    # by RAG_INDEX_WINDOW_OVERLAP); one with more than RAG_INDEX_SENTENCE_MIN_WORDS words also
    # gets a point per sentence.
    RAG_INDEX_MAX_BLOCK_CHARS: int = Field(default=8000, ge=500, le=30000)
    RAG_INDEX_WINDOW_CHARS: int = Field(default=1500, ge=200)
    RAG_INDEX_WINDOW_OVERLAP: int = Field(default=200, ge=0)
    RAG_INDEX_SENTENCE_MIN_WORDS: int = Field(default=100, ge=1)
    # Text over the embedding model's input (its own limit, at most the ceiling) is cut into
    # pieces that fit. Counted with cl100k, times the ratio for models with another tokenizer.
    RAG_EMBED_TOKEN_CEILING: int = Field(default=8191, ge=64)
    RAG_EMBED_TOKEN_RATIO: float = Field(default=2.13, ge=1, le=8)
    # An upload takes the dates its header states ("Date:", "Sent:", "Last updated:"):
    # "off"; "true" in place of its upload time only; "all" also in place of the file's own
    # last-modified time. Switched off, uploads get their own dates back on their next index.
    RAG_CONTENT_DOCUMENT_DATES: Literal["off", "true", "all"] = "off"

    # Retrieval: the dense leg's search beam and int8 rescore oversampling; the record cut
    # (spread a page across records, off by default); tables shown whole up to this many
    # cells; and blocks per page when a record is read whole.
    RAG_SEARCH_HNSW_EF: int = Field(default=256, ge=0, le=4096)
    RAG_SEARCH_OVERSAMPLING: float = Field(default=1.5, ge=1, le=4)
    RAG_SEARCH_RECORD_CUT: bool = False
    # How often records without a title point, and contents whose points lack their records'
    # dates, are looked for.
    RAG_UPKEEP_SWEEP_S: float = Field(default=300, gt=0)
    # A record found by its title (its name, an email's subject, people or date) is shown whole
    # up to this many words, else its opening.
    RAG_TITLE_HIT_WORDS: int = Field(default=700, ge=50)
    # Names found for records not indexed yet: cosine floor (measured with OpenAI's small
    # embedding model; re-measure for others) and how many are listed.
    RAG_TITLE_MIN_SCORE: float = Field(default=0.45, ge=0, le=1)
    RAG_TITLE_UNINDEXED_MAX: int = Field(default=10, ge=0, le=50)
    # A search with date bounds also lists up to 3 matching records the dates left out (a
    # write-up after the period it is about), found by the same search without dates.
    RAG_DATE_SAFETY_NET: bool = True
    RAG_SMALL_TABLE_CELLS: int = Field(default=250, ge=0)
    # A read with a question returns a record whole up to this many characters, else the
    # part that answers it within them.
    RAG_FOCUSED_READ_CHARS: int = Field(default=16_000, ge=4_000)
    RAG_READ_MAX_BLOCKS: int = Field(default=200, ge=1, le=5000)

    # Upload guards: per-file size, and for ZIP-based files (Office, EPUB, ODF) the unpacked
    # size, compression ratio and entry count that mark a zip bomb.
    RAG_MAX_FILE_MB: int = Field(default=200, ge=1)
    RAG_MAX_UNZIPPED_MB: int = Field(default=1024, ge=1)
    RAG_MAX_ZIP_RATIO: int = Field(default=100, ge=1)
    RAG_MAX_ZIP_ENTRIES: int = Field(default=10_000, ge=1)


def load_settings(**overrides: object) -> Settings:
    return Settings(**overrides)  # type: ignore[arg-type]
