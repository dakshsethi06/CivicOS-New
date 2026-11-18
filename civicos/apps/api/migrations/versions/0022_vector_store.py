"""0022_vector_store.sql

Revision ID: 0022
Revises: 0021
"""
from migrations.sqlfile import run

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0022_vector_store.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
