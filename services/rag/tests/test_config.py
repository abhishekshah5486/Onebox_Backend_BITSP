import base64

import pytest
from pydantic import ValidationError

from onebox_rag.config import ROOT_ENV, load_settings


def test_defaults_match_the_other_services(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MONGO_URI", "mongodb://db")
    monkeypatch.setenv("REDIS_URL", "redis://cache")
    monkeypatch.setenv("CREDENTIALS_ENCRYPTION_KEY", base64.b64encode(b"k" * 32).decode())
    monkeypatch.setenv("BLOB_ACCESS_KEY", "a")
    monkeypatch.setenv("BLOB_SECRET_KEY", "s")
    settings = load_settings(_env_file=None)
    assert settings.PORT == 4012
    assert settings.MONGO_DB == "onebox_rag"
    assert settings.AUTH_SERVICE_URL == "http://localhost:4001"
    assert settings.CREDENTIALS_ENCRYPTION_KEY == b"k" * 32
    assert settings.BLOB_ENDPOINT == "http://localhost:8333"
    assert settings.RAG_BLOB_BUCKET == "onebox-rag"


def test_reads_the_repo_env_file() -> None:
    assert ROOT_ENV.name == ".env"
    assert (ROOT_ENV.parent / "turbo.json").exists()


@pytest.mark.parametrize(
    "key", ["not base64!", base64.b64encode(b"short").decode()], ids=["garbled", "short"]
)
def test_rejects_a_bad_encryption_key(key: str) -> None:
    with pytest.raises(ValidationError, match="CREDENTIALS_ENCRYPTION_KEY"):
        load_settings(_env_file=None, MONGO_URI="m", REDIS_URL="r", CREDENTIALS_ENCRYPTION_KEY=key)


def test_needs_its_stores(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("MONGO_URI", "REDIS_URL", "BLOB_ACCESS_KEY", "BLOB_SECRET_KEY"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError) as caught:
        load_settings(
            _env_file=None, CREDENTIALS_ENCRYPTION_KEY=base64.b64encode(b"k" * 32).decode()
        )
    missing = {error["loc"][0] for error in caught.value.errors()}
    assert missing == {"MONGO_URI", "REDIS_URL", "BLOB_ACCESS_KEY", "BLOB_SECRET_KEY"}
