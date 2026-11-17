"""0015_storage.sql

Revision ID: 0015
Revises: 0014
"""
from migrations.sqlfile import run

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0015_storage.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
