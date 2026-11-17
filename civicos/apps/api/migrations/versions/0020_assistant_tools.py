"""0020_assistant_tools.sql

Revision ID: 0020
Revises: 0019
"""
from migrations.sqlfile import run

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0020_assistant_tools.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
