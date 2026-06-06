"""
Shared SQLAlchemy engine and session factory.

Imported as an absolute import from any module in the project:
    from database import get_engine, get_session

Uses DATABASE_URL from the environment (set in .env / Railway config vars).
Connection pool is sized for async workloads where sync DB calls are wrapped
in asyncio.to_thread — keep pool_size moderate to avoid oversubscription.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from sqlalchemy.pool import NullPool

_engine: sa.Engine | None = None


def get_engine() -> sa.Engine:
    """Return the process-level SQLAlchemy engine, creating it on first call."""
    global _engine
    if _engine is None:
        database_url = os.environ["DATABASE_URL"]
        # Railway injects postgres:// URIs; SQLAlchemy 1.4+ requires postgresql://
        if database_url.startswith("postgres://"):
            database_url = database_url.replace("postgres://", "postgresql://", 1)
        _engine = sa.create_engine(
            database_url,
            pool_pre_ping=True,
            pool_size=int(os.environ.get("DB_POOL_SIZE", "5")),
            max_overflow=int(os.environ.get("DB_MAX_OVERFLOW", "10")),
        )
    return _engine


def get_session() -> sa.orm.Session:
    """Return a new SQLAlchemy session bound to the shared engine."""
    return sa.orm.Session(bind=get_engine())
