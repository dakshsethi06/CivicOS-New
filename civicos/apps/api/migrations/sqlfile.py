"""Runs one file from supabase/migrations as an Alembic revision."""
import os
import re
from pathlib import Path

from alembic import context, op
from sqlalchemy import text

SQL_DIR = Path(__file__).resolve().parents[3] / "supabase" / "migrations"


def _shim(sql: str) -> str:
    """TEST ONLY (ALEMBIC_SHIM=1): the same rewrite as supabase/tests/run_rls_test.sh, for plain Postgres without
    PostGIS or pgvector, so the revision chain can be exercised locally."""
    sql = re.sub(r"geometry\([^)]*\)", "text", sql)
    sql = re.sub(r"vector\(\d+\)", "float8[]", sql)
    return "\n".join(line for line in sql.splitlines() if not re.search(r"using (gist|hnsw)", line))


def run(filename: str) -> None:
    sql = (SQL_DIR / filename).read_text(encoding="utf8")
    if os.environ.get("ALEMBIC_SHIM") == "1":
        if filename.startswith("0001_") or "storage.buckets" in sql:
            return                                  # extensions and Supabase Storage do not exist on plain Postgres
        sql = _shim(sql)
    if context.is_offline_mode():
        op.execute(text(sql.replace(":", r"\:")))  # rendered as written; colons are casts, not bind parameters
    else:
        # the driver's own cursor with no parameters: the file runs exactly as written (its % signs are format()
        # patterns, not placeholders), multiple statements included, inside Alembic's transaction
        cur = op.get_bind().connection.cursor()
        try:
            cur.execute(sql)
        finally:
            cur.close()
