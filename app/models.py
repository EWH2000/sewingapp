"""SQLModel tables for the Sewing app.

One file = the whole data shape (mirrors pantryapp/choresapp/cercoachapp).

Two tables:
  Pattern  — a saved pattern as ONE structured JSON document (the DESIGN.md
             model: name + kind + params, in real millimetres). The PDF is
             generated in the browser from this doc on demand; the server is the
             durable, backed-up store of the doc itself (server-SQLite decision).
  Setting  — a tiny key/value store for app/printer config (the printer URI and
             a per-printer "calibrated" flag), editable from her phone with no
             shell access and surviving image rebuilds on the named volume.

NB: no `from __future__ import annotations` (it stringifies SQLModel field
annotations and can break the mapper — same gotcha the sibling apps note).
"""
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel


def _now() -> datetime:
    """Timezone-aware UTC now (SQLite stores naive-UTC; rendered locally)."""
    return datetime.now(timezone.utc)


class Pattern(SQLModel, table=True):
    """A saved pattern document. `params_json` holds the structured doc the
    browser turns into a tiled 1:1 PDF (e.g. {"widthMm":300,"heightMm":380}
    for a rectangle, box dimensions for a tote, …). Kept as text so the doc can
    evolve (more piece types, curves, notches) without a migration."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    kind: str = "rectangle"          # rectangle | box | … (grows with the templates)
    params_json: str = "{}"          # the structured pattern document, as JSON text
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Setting(SQLModel, table=True):
    """Key/value app config. Keys in use:
        printer_uri          → e.g. ipp://192.168.8.198:631/ipp/print
        calibrated:<uri>     → "1" once she's confirmed a test page measured true
    """
    key: str = Field(primary_key=True)
    value: str = ""
    updated_at: datetime = Field(default_factory=_now)
