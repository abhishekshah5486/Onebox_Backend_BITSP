import time
from collections.abc import Iterator
from typing import Annotated

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from onebox_rag.app import create_app
from onebox_rag.auth import (
    INTERNAL_TOKEN_HEADER,
    AuthUser,
    current_user,
    derive_internal_token,
    require_internal,
)
from onebox_rag.config import Settings
from tests.conftest import KEY
from tests.tokens import fake_verifier, token


@pytest.fixture
def jwks_calls() -> list[str]:
    return []


@pytest.fixture
def client(settings: Settings, jwks_calls: list[str]) -> Iterator[TestClient]:
    app: FastAPI = create_app(settings, verifier=fake_verifier(jwks_calls), checks={})

    @app.get("/whoami")
    async def whoami(user: Annotated[AuthUser, Depends(current_user)]) -> dict[str, str]:
        return {"userId": user.user_id, "email": user.email}

    @app.get("/internal/ping", dependencies=[Depends(require_internal)])
    async def ping() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app) as test_client:
        yield test_client


def test_derives_the_same_internal_token_as_auth_kit() -> None:
    # Computed with packages/auth-kit's deriveInternalToken for bytes 0..31.
    assert derive_internal_token(KEY) == "LexkiHLef1l4wDBXgPNJOMCM6rcms8d58gpSBv3Zl3k"


def test_accepts_a_token_from_the_auth_service_and_caches_its_keys(
    client: TestClient, jwks_calls: list[str]
) -> None:
    for _ in range(2):
        response = client.get("/whoami", headers={"authorization": f"Bearer {token()}"})
        assert response.json() == {"userId": "user-1", "email": "me@onebox.dev"}
    assert jwks_calls == ["http://auth.test/.well-known/jwks.json"]


@pytest.mark.parametrize(
    ("headers", "code"),
    [
        ({}, "MISSING_TOKEN"),
        ({"authorization": "Basic abc"}, "MISSING_TOKEN"),
        ({"authorization": "Bearer nonsense"}, "INVALID_TOKEN"),
        ({"authorization": f"Bearer {token(exp=int(time.time()) - 60)}"}, "TOKEN_EXPIRED"),
        ({"authorization": f"Bearer {token(aud='someone-else')}"}, "INVALID_TOKEN"),
        ({"authorization": f"Bearer {token(email=None)}"}, "INVALID_TOKEN"),
    ],
    ids=["none", "not-bearer", "garbled", "expired", "audience", "no-email"],
)
def test_rejects_requests_without_a_valid_token(
    client: TestClient, headers: dict[str, str], code: str
) -> None:
    response = client.get("/whoami", headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == code


def test_rejects_a_key_the_auth_service_does_not_publish(client: TestClient) -> None:
    other = jwt.encode(
        {"sub": "u", "email": "e", "iss": "onebox-auth", "aud": "onebox"},
        Ed25519PrivateKey.generate(),
        algorithm="EdDSA",
        headers={"kid": "unknown"},
    )
    response = client.get("/whoami", headers={"authorization": f"Bearer {other}"})
    assert response.json()["error"]["code"] == "INVALID_TOKEN"


def test_internal_routes_need_the_internal_token(client: TestClient) -> None:
    assert client.get("/internal/ping").json()["error"]["code"] == "INTERNAL_ONLY"
    wrong = client.get("/internal/ping", headers={INTERNAL_TOKEN_HEADER: "nope"})
    assert wrong.status_code == 401
    right = client.get(
        "/internal/ping", headers={INTERNAL_TOKEN_HEADER: derive_internal_token(KEY)}
    )
    assert right.json() == {"ok": True}
