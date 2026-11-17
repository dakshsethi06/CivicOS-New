"""0002_saas.sql

Revision ID: 0002
Revises: 0001
"""
from migrations.sqlfile import run

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0002_saas.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
