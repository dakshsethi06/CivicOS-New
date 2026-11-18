"""0021_field_teams.sql

Revision ID: 0021
Revises: 0020
"""
from migrations.sqlfile import run

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0021_field_teams.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
