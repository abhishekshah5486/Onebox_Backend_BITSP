import shutil
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from onebox_rag.config import ROOT_ENV, EncryptionKey


def _soffice() -> str:
    return shutil.which("soffice") or shutil.which("libreoffice") or "soffice"


class DoclingSettings(BaseSettings):
    """The Docling service: its own process and image, since PyTorch and the models are heavy."""

    model_config = SettingsConfigDict(env_file=ROOT_ENV, extra="ignore", frozen=True)

    DOCLING_PORT: int = Field(default=4013, ge=1, le=65535)
    HOST: str = "0.0.0.0"  # noqa: S104 - only the RAG service calls it, inside the cluster
    LOG_LEVEL: Literal["debug", "info", "warning", "error"] = "info"
    CREDENTIALS_ENCRYPTION_KEY: EncryptionKey

    # Conversions run in our parse pool: one model-holding process per worker.
    DOCLING_WORKERS: int = Field(default=1, ge=1)
    DOCLING_TIMEOUT_S: float = Field(default=600, gt=0)
    DOCLING_MEMORY_MB: int = Field(default=6144, ge=0)
    DOCLING_WORKER_MAX_JOBS: int = Field(default=50, ge=0)
    # Files waiting beyond the busy workers before callers get 429 and retry later.
    DOCLING_MAX_QUEUED: int = Field(default=4, ge=0)
    DOCLING_TABLE_MODE: Literal["accurate", "fast"] = "accurate"
    # "rapidocr" reads text inside pictures in PDFs (screenshots, pasted scans); off by default.
    DOCLING_OCR: Literal["off", "rapidocr"] = "off"
    DOCLING_IMAGES_SCALE: float = Field(default=1.0, gt=0, le=4)
    SOFFICE_PATH: str = Field(default_factory=_soffice)


def load_docling_settings(**overrides: object) -> DoclingSettings:
    return DoclingSettings(**overrides)  # type: ignore[arg-type]
