"""0009_mumbai_models.sql

Revision ID: 0009
Revises: 0008
"""
from migrations.sqlfile import run

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0009_mumbai_models.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
