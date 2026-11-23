import asyncio
import base64
import hmac
import time
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
import jwt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import Depends, Request

from onebox_rag.errors import UnauthorizedError

# Same values as packages/auth-kit, so its tokens verify here (names, not secrets).
TOKEN_ISSUER = "onebox-auth"  # noqa: S105
TOKEN_AUDIENCE = "onebox"  # noqa: S105
INTERNAL_TOKEN_HEADER = "x-onebox-internal-token"  # noqa: S105

JWKS_TTL_S = 600.0
JWKS_COOLDOWN_S = 30.0
JWKS_TIMEOUT_S = 5.0


def derive_internal_token(encryption_key: bytes) -> str:
    """The token services send each other, derived from the shared key (auth-kit's
    deriveInternalToken)."""
    raw = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"onebox", info=b"internal-api").derive(
        encryption_key
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@dataclass(frozen=True)
class AuthUser:
    user_id: str
    email: str


class JwksVerifier:
    """Checks access tokens against the auth service's signing keys, fetched and cached like
    jose's remote key set: kept for ten minutes, refetched early (at most every 30s) for a key
    it has not seen."""

    def __init__(self, auth_service_url: str, client: httpx.AsyncClient | None = None) -> None:
        self._url = auth_service_url.rstrip("/") + "/.well-known/jwks.json"
        self._client = client or httpx.AsyncClient(timeout=JWKS_TIMEOUT_S)
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at = float("-inf")
        self._lock = asyncio.Lock()

    async def _refresh(self, *, force: bool) -> None:
        async with self._lock:
            age = time.monotonic() - self._fetched_at
            if age < (JWKS_COOLDOWN_S if force else JWKS_TTL_S):
                return
            response = await self._client.get(self._url)
            response.raise_for_status()
            keys = jwt.PyJWKSet.from_dict(response.json()).keys
            self._keys = {key.key_id: key for key in keys if key.key_id}
            self._fetched_at = time.monotonic()

    async def _key(self, kid: str) -> jwt.PyJWK:
        await self._refresh(force=False)
        if kid not in self._keys:
            await self._refresh(force=True)
        key = self._keys.get(kid)
        if key is None:
            raise UnauthorizedError("Invalid access token", code="INVALID_TOKEN")
        return key

    async def verify(self, token: str) -> AuthUser:
        try:
            kid = jwt.get_unverified_header(token).get("kid")
            if not isinstance(kid, str):
                raise jwt.InvalidTokenError("token has no key id")
            key = await self._key(kid)
            claims: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=["EdDSA"],
                issuer=TOKEN_ISSUER,
                audience=TOKEN_AUDIENCE,
            )
        except jwt.ExpiredSignatureError as err:
            raise UnauthorizedError("Access token expired", code="TOKEN_EXPIRED") from err
        except (jwt.InvalidTokenError, httpx.HTTPError) as err:
            raise UnauthorizedError("Invalid access token", code="INVALID_TOKEN") from err
        sub, email = claims.get("sub"), claims.get("email")
        if not isinstance(sub, str) or not isinstance(email, str):
            raise UnauthorizedError("Invalid access token", code="INVALID_TOKEN")
        return AuthUser(user_id=sub, email=email)


def _bearer(request: Request) -> str | None:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer":
        return None
    return token.strip() or None


async def current_user(request: Request) -> AuthUser:
    token = _bearer(request)
    if token is None:
        raise UnauthorizedError("Missing bearer token", code="MISSING_TOKEN")
    verifier: JwksVerifier = request.app.state.verifier
    return await verifier.verify(token)


async def require_internal(request: Request) -> None:
    expected: str = request.app.state.internal_token
    presented = request.headers.get(INTERNAL_TOKEN_HEADER, "")
    if not hmac.compare_digest(presented.encode(), expected.encode()):
        raise UnauthorizedError("Internal endpoint", code="INTERNAL_ONLY")


CurrentUser = Annotated[AuthUser, Depends(current_user)]
