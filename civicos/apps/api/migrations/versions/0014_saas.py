"""0014_saas.sql

Revision ID: 0014
Revises: 0013
"""
from migrations.sqlfile import run

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run("0014_saas.sql")


def downgrade() -> None:
    raise NotImplementedError("SQL migrations are forward-only; restore from a backup to go back.")
