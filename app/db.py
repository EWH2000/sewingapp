"""SQLite engine, session dependency, and small settings helpers.

Mirrors the sibling apps: one SQLite file, path from an env var so dev uses
./sewing.db and the container uses /data/sewing.db on the mounted volume.
"""
from __future__ import annotations

import os

from sqlmodel import Session, SQLModel, create_engine, select

from . import models  # noqa: F401  (register tables on SQLModel.metadata)
from .models import Setting

DB_PATH = os.environ.get("SEWING_DB_PATH", "sewing.db")

# check_same_thread=False: FastAPI may touch the session across the threadpool.
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    echo=False,
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session


# ── settings helpers (the printer URI + per-printer calibration flag) ─────────
def get_setting(key: str, default: str | None = None) -> str | None:
    with Session(engine) as s:
        row = s.get(Setting, key)
        return row.value if row else default


def set_setting(key: str, value: str) -> None:
    from .models import _now
    with Session(engine) as s:
        row = s.get(Setting, key)
        if row:
            row.value, row.updated_at = value, _now()
        else:
            row = Setting(key=key, value=value)
        s.add(row)
        s.commit()
