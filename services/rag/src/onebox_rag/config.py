import base64
import binascii
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BeforeValidator, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

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
    RAG_INGEST_ATTEMPTS: int = Field(default=5, ge=1)
    RAG_INGEST_BACKOFF_MS: int = Field(default=5_000, ge=0)

    # Upload guards: per-file size, and for ZIP-based files (Office, EPUB, ODF) the unpacked
    # size, compression ratio and entry count that mark a zip bomb.
    RAG_MAX_FILE_MB: int = Field(default=200, ge=1)
    RAG_MAX_UNZIPPED_MB: int = Field(default=1024, ge=1)
    RAG_MAX_ZIP_RATIO: int = Field(default=100, ge=1)
    RAG_MAX_ZIP_ENTRIES: int = Field(default=10_000, ge=1)


def load_settings(**overrides: object) -> Settings:
    return Settings(**overrides)  # type: ignore[arg-type]
