"""0003_city.sql

Revision ID: 0003
Revises: 0002
"""
from migrations.sqlfile import run

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0003_city.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
