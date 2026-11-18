"""0008_mumbai_data.sql

Revision ID: 0008
Revises: 0007
"""
from migrations.sqlfile import run

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0008_mumbai_data.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
