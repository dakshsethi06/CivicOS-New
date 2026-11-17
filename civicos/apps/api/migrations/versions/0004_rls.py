"""0004_rls.sql

Revision ID: 0004
Revises: 0003
"""
from migrations.sqlfile import run

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0004_rls.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
