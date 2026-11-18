"""0023_more_forecasts.sql

Revision ID: 0023
Revises: 0022
"""
from migrations.sqlfile import run

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0023_more_forecasts.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
