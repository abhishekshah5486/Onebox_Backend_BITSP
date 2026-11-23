import base64
import os
from collections.abc import Iterator
from typing import TYPE_CHECKING

import pytest

from onebox_rag.config import Settings, load_settings

if TYPE_CHECKING:
    from tests.stores import Stores

# Testcontainers' reaper can't read its own port mapping on Docker Desktop 28; every test stops
# its containers itself (with blocks), so it isn't needed.
os.environ.setdefault("TESTCONTAINERS_RYUK_DISABLED", "true")

KEY = bytes(range(32))


@pytest.fixture
def settings() -> Settings:
    return load_settings(
        _env_file=None,
        MONGO_URI="mongodb://localhost:27017",
        REDIS_URL="redis://localhost:6379",
        CREDENTIALS_ENCRYPTION_KEY=base64.b64encode(KEY).decode(),
        BLOB_ACCESS_KEY="testaccesskey",
        BLOB_SECRET_KEY="testsecretkey",
        # Docling tests start their own; never reach one running in dev.
        RAG_DOCLING_URL="",
        RAG_LLM_PROXY_URL="",
        RAG_MAIL_URL="",
        QDRANT_URL="",
    )


@pytest.fixture(scope="session")
def stores() -> Iterator["Stores"]:
    # Imported here so unit runs never touch Docker.
    from tests.stores import running_stores

    with running_stores() as running:
        yield running


@pytest.fixture
def live_settings(settings: Settings, stores: "Stores") -> Settings:
    return settings.model_copy(update=stores.settings())
