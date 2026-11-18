"""0018_operations.sql

Revision ID: 0018
Revises: 0017
"""
from migrations.sqlfile import run

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0018_operations.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
