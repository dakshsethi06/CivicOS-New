"""0019_complaint_ai.sql

Revision ID: 0019
Revises: 0018
"""
from migrations.sqlfile import run

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0019_complaint_ai.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
