"""0016_three_year_forecasts.sql

Revision ID: 0016
Revises: 0015
"""
from migrations.sqlfile import run

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0016_three_year_forecasts.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
