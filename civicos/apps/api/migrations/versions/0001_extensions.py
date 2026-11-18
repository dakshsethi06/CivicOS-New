"""0001_extensions.sql

Revision ID: 0001
Revises: None
"""
from migrations.sqlfile import run

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0001_extensions.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
