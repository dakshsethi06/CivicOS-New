"""0012_assistant.sql

Revision ID: 0012
Revises: 0010
"""
from migrations.sqlfile import run

revision = "0012"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0012_assistant.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
