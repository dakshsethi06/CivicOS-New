"""0006_indicators.sql

Revision ID: 0006
Revises: 0005
"""
from migrations.sqlfile import run

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0006_indicators.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
