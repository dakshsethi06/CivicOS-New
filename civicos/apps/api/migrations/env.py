"""Alembic environment: connects with DATABASE_URL (apps/api/.env) and runs the SQL migration revisions."""
from alembic import context
from sqlalchemy import create_engine, pool

from app.config import get_settings


def run_migrations_offline() -> None:
    context.configure(url=get_settings().sqlalchemy_url, literal_binds=True, dialect_opts={"paramstyle": "named"},
                      version_table_schema="alembic")
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # prepare_threshold=None: the Supabase transaction pooler does not support prepared statements
    engine = create_engine(get_settings().sqlalchemy_url, poolclass=pool.NullPool, connect_args={"prepare_threshold": None})
    with engine.connect() as connection:
        # the bookkeeping table lives in its own schema: in "public" Supabase would expose it through the REST API
        connection.exec_driver_sql("create schema if not exists alembic")
        connection.commit()
        context.configure(connection=connection, transaction_per_migration=True, version_table_schema="alembic")
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
