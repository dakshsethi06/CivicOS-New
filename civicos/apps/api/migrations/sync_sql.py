"""Creates an Alembic revision for every SQL file in supabase/migrations that does not have one yet.

    python migrations/sync_sql.py

Revisions are named after the file's number (0001, 0002, ...) and chained in file order. Run it after adding a SQL
migration, then `alembic upgrade head`.
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSIONS = HERE / "versions"
SQL_DIR = HERE.parents[2] / "supabase" / "migrations"

TEMPLATE = '''"""{filename}

Revision ID: {rev}
Revises: {down}
"""
from migrations.sqlfile import run

revision = "{rev}"
down_revision = {down_repr}
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("{filename}")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
'''


def main() -> None:
    VERSIONS.mkdir(exist_ok=True)
    files = sorted(p.name for p in SQL_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    prev = None
    made = 0
    for name in files:
        rev = re.match(r"(\d{4})_", name).group(1)
        target = VERSIONS / f"{rev}_{name[5:-4]}.py"
        if not target.exists():
            target.write_text(TEMPLATE.format(filename=name, rev=rev, down=prev or "None",
                                              down_repr=f'"{prev}"' if prev else "None"), encoding="utf8", newline="\n")
            made += 1
        prev = rev
    print(f"{made} new revision(s); head is {prev}")


if __name__ == "__main__":
    main()
