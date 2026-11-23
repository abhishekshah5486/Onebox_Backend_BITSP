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


def load_settings(**overrides: object) -> Settings:
    return Settings(**overrides)  # type: ignore[arg-type]
