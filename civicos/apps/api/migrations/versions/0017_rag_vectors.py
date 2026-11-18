"""0017_rag_vectors.sql

Revision ID: 0017
Revises: 0016
"""
from migrations.sqlfile import run

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0017_rag_vectors.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
