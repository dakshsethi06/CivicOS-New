"""0005_complaints.sql

Revision ID: 0005
Revises: 0004
"""
from migrations.sqlfile import run

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0005_complaints.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
