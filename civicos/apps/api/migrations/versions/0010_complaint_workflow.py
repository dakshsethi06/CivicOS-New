"""0010_complaint_workflow.sql

Revision ID: 0010
Revises: 0009
"""
from migrations.sqlfile import run

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0010_complaint_workflow.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
