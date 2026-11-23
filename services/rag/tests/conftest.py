import base64
import os

import pytest

from onebox_rag.config import Settings, load_settings

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
    )
