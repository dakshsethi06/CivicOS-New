"""0013_insights.sql

Revision ID: 0013
Revises: 0012
"""
from migrations.sqlfile import run

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0013_insights.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
