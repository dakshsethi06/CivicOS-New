"""0007_dashboard_queries.sql

Revision ID: 0007
Revises: 0006
"""
from migrations.sqlfile import run

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0007_dashboard_queries.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
