"""Alembic environment — async engine (asyncpg), models as metadata source.

DATABASE_URL comes from the environment (Neon connection string, or a local
throwaway Postgres for generating migrations). The `postgresql://` scheme is
rewritten to `postgresql+asyncpg://` so one env var serves both asyncpg
repositories and Alembic.
"""

import asyncio
import os
from logging.config import fileConfig
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context
from app.db.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", config.get_main_option("sqlalchemy.url"))
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    elif url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)
    # The SQLAlchemy asyncpg dialect rejects libpq's sslmode/channel_binding
    # params (raw asyncpg accepts them): map sslmode→ssl, drop channel_binding.
    parts = urlsplit(url)
    if parts.query:
        params = dict(parse_qsl(parts.query))
        sslmode = params.pop("sslmode", None)
        params.pop("channel_binding", None)
        if sslmode and "ssl" not in params:
            params["ssl"] = sslmode
        url = urlunsplit(parts._replace(query=urlencode(params)))
    return url


def run_migrations_offline() -> None:
    """Emit SQL to stdout (--sql mode) without a DB connection."""
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def _run_async_migrations() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _database_url()
    connectable = async_engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(_run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
