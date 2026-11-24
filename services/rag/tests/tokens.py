import json
import time
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from onebox_rag.auth import JwksVerifier

# Stands in for the auth service's signing key and JWKS endpoint.
SIGNING_KEY = Ed25519PrivateKey.generate()


def jwks() -> dict[str, Any]:
    public = json.loads(jwt.algorithms.OKPAlgorithm.to_jwk(SIGNING_KEY.public_key()))
    return {"keys": [{**public, "kid": "k1", "alg": "EdDSA", "use": "sig"}]}


def token(**claims: Any) -> str:
    now = int(time.time())
    payload = {
        "sub": "user-1",
        "email": "me@onebox.dev",
        "iss": "onebox-auth",
        "aud": "onebox",
        "iat": now,
        "exp": now + 900,
        **claims,
    }
    return jwt.encode(payload, SIGNING_KEY, algorithm="EdDSA", headers={"kid": "k1"})


def fake_verifier(calls: list[str] | None = None) -> JwksVerifier:
    def serve(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(str(request.url))
        return httpx.Response(200, json=jwks())

    return JwksVerifier("http://auth.test", httpx.AsyncClient(transport=httpx.MockTransport(serve)))


def bearer(user_id: str = "user-1") -> dict[str, str]:
    return {"authorization": f"Bearer {token(sub=user_id)}"}
