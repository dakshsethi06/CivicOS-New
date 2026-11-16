"""Verifies the Supabase access token the web app forwards, and turns it into the caller's identity.

The same token's claims are then set on the database connection (see db.as_user), so every query runs under the
caller's Row Level Security, exactly as when the browser talks to Supabase directly.
"""
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import jwt
from fastapi import Depends, Header, HTTPException, status

from .config import Settings, get_settings

STAFF_ROLES = {"city_admin", "dept_officer", "field_worker", "super_admin"}
OFFICER_ROLES = {"city_admin", "dept_officer"}


@dataclass(frozen=True)
class User:
    id: str
    email: str | None
    org_id: str
    role: str
    claims: dict[str, Any]

    @property
    def is_officer(self) -> bool:
        return self.role in OFFICER_ROLES


@lru_cache
def _jwks_client(supabase_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json", cache_keys=True, lifespan=600)


def decode_token(token: str, settings: Settings) -> dict[str, Any]:
    """Checks signature, expiry and audience. Asymmetric tokens (ES256/RS256) use the project's JWKS;
    legacy HS256 tokens need SUPABASE_JWT_SECRET."""
    try:
        alg = jwt.get_unverified_header(token).get("alg")
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise jwt.InvalidTokenError("HS256 token but SUPABASE_JWT_SECRET is not set")
            key: Any = settings.supabase_jwt_secret
        elif alg in ("ES256", "RS256", "EdDSA"):
            key = _jwks_client(settings.supabase_url).get_signing_key_from_jwt(token).key
        else:
            raise jwt.InvalidTokenError(f"Unsupported token algorithm {alg}")
        return jwt.decode(token, key, algorithms=[alg], audience="authenticated", options={"require": ["exp", "sub"]})
    except jwt.PyJWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid session: {e}") from e


def user_from_claims(claims: dict[str, Any]) -> User:
    meta = claims.get("app_metadata") or {}
    if not meta.get("org_id") or not meta.get("role"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is not linked to an organization.")
    return User(id=claims["sub"], email=claims.get("email"), org_id=meta["org_id"], role=meta["role"], claims=claims)


def current_user(authorization: str | None = Header(default=None), settings: Settings = Depends(get_settings)) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in first.")
    return user_from_claims(decode_token(authorization.split(" ", 1)[1].strip(), settings))


def current_officer(user: User = Depends(current_user)) -> User:
    if not user.is_officer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only City Administrators and Department Officers can do this.")
    return user
