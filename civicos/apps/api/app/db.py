"""Database access as the signed-in user.

The API connects with the database owner's connection string but, inside every transaction, switches to the
`authenticated` role and sets the caller's JWT claims, the same way Supabase's own REST layer does. Row Level
Security therefore decides what each query can see or change: a user of one municipality can never read another's
documents, and a resident never sees staff-only documents, whatever this code does.
"""
import json
from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from typing import Any

from sqlalchemy import Connection, create_engine, text
from sqlalchemy.engine import Engine

from .auth import User
from .config import get_settings


@lru_cache
def get_engine() -> Engine:
    s = get_settings()
    # prepare_threshold=None: the Supabase transaction pooler does not support prepared statements
    return create_engine(s.sqlalchemy_url, pool_pre_ping=True, pool_size=5, max_overflow=5,
                         connect_args={"prepare_threshold": None})


@contextmanager
def as_user(user: User) -> Iterator[Connection]:
    """One transaction, run as `user` under RLS. Settings are transaction-local, so a pooled connection never
    carries one user's identity into another request."""
    with get_engine().begin() as conn:
        conn.execute(
            text("select set_config('request.jwt.claims', :claims, true), set_config('role', 'authenticated', true)"),
            {"claims": json.dumps(user.claims)},
        )
        yield conn


def org_claims(org_id: str, user_id: str | None = None) -> dict[str, Any]:
    """Claims for background jobs: the organization's administrator role, scoped to that one organization. RLS still
    applies, so a job can only read and write that organization's rows."""
    claims: dict[str, Any] = {"role": "authenticated", "app_metadata": {"org_id": org_id, "role": "city_admin"}}
    if user_id:
        claims["sub"] = user_id
    return claims


@contextmanager
def as_org(org_id: str, user_id: str | None = None) -> Iterator[Connection]:
    with get_engine().begin() as conn:
        conn.execute(
            text("select set_config('request.jwt.claims', :claims, true), set_config('role', 'authenticated', true)"),
            {"claims": json.dumps(org_claims(org_id, user_id))},
        )
        yield conn


def vector_literal(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"


def scalar(conn: Connection, sql: str, params: dict[str, Any] | None = None) -> Any:
    return conn.execute(text(sql), params or {}).scalar()
