"""Sewing — FastAPI app + routes.

A phone-friendly tool for the household to author sewing patterns and print them
at home at exact 1:1 scale (tiled across US-Letter sheets) or save them for
later. PDFs are generated in the BROWSER (vendored pdf-lib, reusing the verified
tiling geometry); this server stores the pattern documents (SQLite, backed up)
and relays the generated PDF straight to the networked printer over IPP
(app/printing.py — no CUPS, no drivers, no root). See DESIGN.md / PRINTING.md.

Conventions match the box's other apps: server-rendered Jinja2, one language
(Python) front-to-back, BASE_PATH so the same image serves at "/" in dev and
under "/sewing/" behind the hub's Caddy proxy.
"""
from __future__ import annotations

import json
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlmodel import Session, select
from starlette.concurrency import run_in_threadpool

from .db import engine, get_setting, init_db, set_setting
from .models import Pattern, _now
from .printing import (
    JOB_STATE_ATTENTION, JOB_STATE_DONE, JOB_STATE_LABEL, PrinterError,
    get_printer_state, ipp_print, job_status, validate_job, validate_printer_uri,
)

BASE_PATH = os.environ.get("BASE_PATH", "").rstrip("/")
# Default printer (FALLBACK only). The printer is a separate LAN host addressed
# by its own IP — NOT host.containers.internal. The app prefers the value stored
# in settings (editable from her phone); this env is just the seed default.
ENV_PRINTER_URI = os.environ.get("SEWING_PRINTER_URI", "")
APP_DIR = os.path.dirname(__file__)
STATIC_DIR = os.path.join(APP_DIR, "static")
MAX_PDF_BYTES = 12 * 1024 * 1024


def _compute_asset_ver() -> str:
    """A short content hash over the CSS/JS assets, appended as ``?v=`` to every
    asset URL in the templates. StaticFiles sends only ETag/Last-Modified (no
    Cache-Control), so iOS Safari's heuristic cache will happily serve a stale
    JS file for hours without revalidating — which silently pins old, broken
    code on her iPad after a deploy. A content-derived URL changes whenever a
    file's bytes change, so the browser is forced to fetch the new version."""
    import hashlib
    h = hashlib.sha1()
    for root, _dirs, files in os.walk(STATIC_DIR):
        for fn in sorted(files):
            if fn.endswith((".js", ".css")):
                h.update(fn.encode("utf-8"))
                try:
                    with open(os.path.join(root, fn), "rb") as f:
                        h.update(f.read())
                except OSError:
                    pass
    return h.hexdigest()[:10]


ASSET_VER = _compute_asset_ver()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if ENV_PRINTER_URI and not get_setting("printer_uri"):
        try:
            set_setting("printer_uri", validate_printer_uri(ENV_PRINTER_URI))
        except PrinterError:
            pass
    yield


app = FastAPI(title="Sewing", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=os.path.join(APP_DIR, "templates"))
templates.env.globals.update(base_path=BASE_PATH, asset_ver=ASSET_VER)


# ── printer/config helpers ────────────────────────────────────────────────────
def resolve_printer_uri() -> str:
    return (get_setting("printer_uri") or ENV_PRINTER_URI or "").strip()


def is_calibrated(uri: str) -> bool:
    return get_setting(f"calibrated:{uri}") == "1"


# single in-process serializer so two devices can't interleave one tiled set
_lock = {"busy": False, "t": 0.0}
_MIN_GAP = 8.0


def _clamp(v, lo, hi):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return lo


# ── pages ─────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    with Session(engine) as s:
        patterns = s.exec(select(Pattern).order_by(Pattern.updated_at.desc())).all()
    uri = resolve_printer_uri()
    return templates.TemplateResponse(request, "index.html", {
        "active_tab": "home", "patterns": patterns,
        "printer_uri": uri, "calibrated": is_calibrated(uri) if uri else False,
    })


@app.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    uri = resolve_printer_uri()
    return templates.TemplateResponse(request, "settings.html", {
        "active_tab": "settings",
        "printer_uri": uri, "calibrated": is_calibrated(uri) if uri else False,
    })


@app.get("/edit", response_class=HTMLResponse)
async def edit_new(request: Request):
    """Freeform editor — a blank new shape. The doc is built client-side."""
    return templates.TemplateResponse(request, "edit.html", {
        "active_tab": "draw", "pattern": None,
    })


@app.get("/edit/{pid}", response_class=HTMLResponse)
async def edit_existing(request: Request, pid: int):
    """Freeform editor over an existing pattern. Only id/name/kind are injected;
    the editor fetches the document itself via the existing GET /patterns/{id}."""
    with Session(engine) as s:
        row = s.get(Pattern, pid)
        if not row:
            raise HTTPException(404, "Pattern not found.")
        pattern = {"id": row.id, "name": row.name, "kind": row.kind}
    return templates.TemplateResponse(request, "edit.html", {
        "active_tab": "draw", "pattern": pattern,
    })


@app.get("/preview/{pid}", response_class=HTMLResponse)
async def preview_pattern(request: Request, pid: int):
    """Assembled 3D preview of a saved pattern. Read-only of the document — never
    touches the print spine. Only id/name/kind are injected (mirrors /edit); the
    preview fetches the full doc client-side via the existing GET /patterns/{id}."""
    with Session(engine) as s:
        row = s.get(Pattern, pid)
        if not row:
            raise HTTPException(404, "Pattern not found.")
        pattern = {"id": row.id, "name": row.name, "kind": row.kind}
    return templates.TemplateResponse(request, "preview.html", {
        "active_tab": "draw", "pattern": pattern,
    })


@app.get("/health")
async def health():
    return {"ok": True}


# ── pattern documents (server-side SQLite store) ──────────────────────────────
@app.get("/patterns")
async def list_patterns():
    """Read-only id/name/kind list (newest first). Used by tools/seed-examples.mjs to
    POST example garments idempotently (skip a name that already exists)."""
    with Session(engine) as s:
        rows = s.exec(select(Pattern).order_by(Pattern.updated_at.desc())).all()
        return [{"id": r.id, "name": r.name, "kind": r.kind} for r in rows]


@app.post("/patterns")
async def save_pattern(payload: dict):
    name = (payload.get("name") or "Untitled").strip()[:120]
    kind = (payload.get("kind") or "rectangle").strip()[:40]
    params = json.dumps(payload.get("params") or {})
    with Session(engine) as s:
        pid = payload.get("id")
        row = s.get(Pattern, pid) if pid else None
        if row:
            row.name, row.kind, row.params_json, row.updated_at = name, kind, params, _now()
        else:
            row = Pattern(name=name, kind=kind, params_json=params)
        s.add(row); s.commit(); s.refresh(row)
        return {"id": row.id, "name": row.name, "kind": row.kind}


@app.get("/patterns/{pid}")
async def get_pattern(pid: int):
    with Session(engine) as s:
        row = s.get(Pattern, pid)
        if not row:
            raise HTTPException(404, "Pattern not found.")
        return {"id": row.id, "name": row.name, "kind": row.kind,
                "params": json.loads(row.params_json or "{}")}


@app.delete("/patterns/{pid}")
async def delete_pattern(pid: int):
    with Session(engine) as s:
        row = s.get(Pattern, pid)
        if row:
            s.delete(row); s.commit()
    return {"ok": True}


# ── printer settings + status ─────────────────────────────────────────────────
@app.post("/settings/printer")
async def save_printer(payload: dict):
    try:
        uri = validate_printer_uri(payload.get("printer_uri", ""))
    except PrinterError as e:
        raise HTTPException(400, e.message)
    set_setting("printer_uri", uri)
    return {"ok": True, "printer_uri": uri}


@app.post("/printer/test")
async def printer_test():
    uri = resolve_printer_uri()
    if not uri:
        raise HTTPException(409, "No printer configured yet.")
    try:
        state = await run_in_threadpool(get_printer_state, uri)
    except PrinterError as e:
        raise HTTPException(502, detail={"code": e.code, "message": e.message})
    return {**state, "calibrated": is_calibrated(uri)}


@app.post("/printer/calibrated")
async def set_calibrated(payload: dict):
    uri = resolve_printer_uri()
    if not uri:
        raise HTTPException(409, "No printer configured.")
    set_setting(f"calibrated:{uri}", "1" if payload.get("calibrated", True) else "0")
    return {"ok": True, "calibrated": is_calibrated(uri)}


# ── print: relay a browser-generated PDF straight to the printer ──────────────
def _preflight(uri: str, opts: dict):
    """Blocking checks before paper (run in the threadpool). Raises PrinterError."""
    validate_printer_uri(uri)
    state = get_printer_state(uri)
    if state["accepting"] is False or state["state"] == 5:
        reason = ", ".join(state["reasons"]) or "the printer is stopped"
        raise PrinterError(f"The printer isn't ready ({reason}).", "not_ready")
    if state["media_ready"] and not state["letter_ready"]:
        raise PrinterError("Load US Letter paper — the printer has a different size.", "wrong_paper")
    if validate_job(uri, opts) != 0x0000:
        raise PrinterError("The printer rejected the print settings.", "rejected")


@app.post("/print")
async def print_pattern(
    pdf: UploadFile = File(...),
    kind: str = Form("pattern"),
    confirm: bool = Form(False),
    copies: int = Form(1),
    job_name: str = Form("sewing"),
):
    uri = resolve_printer_uri()
    if not uri:
        raise HTTPException(409, detail={"code": "no_printer", "message": "No printer configured yet."})
    if not confirm:
        raise HTTPException(400, detail={"code": "confirm", "message": "Confirmation required."})
    if kind != "calibration" and not is_calibrated(uri):
        raise HTTPException(409, detail={"code": "needs_calibration",
                            "message": "Print and measure the test page first."})
    now = time.monotonic()
    if _lock["busy"] or now - _lock["t"] < _MIN_GAP:
        raise HTTPException(429, detail={"code": "busy", "message": "A print is already running — give it a moment."})
    # Claim the lock BEFORE any await — the check-and-set has no await between it
    # and here, so it's atomic on the event loop; two concurrent /print requests
    # can't both get past it (the serializer's whole job). Released in `finally`.
    _lock["busy"] = True
    try:
        data = await pdf.read()
        if data[:5] != b"%PDF-":
            raise HTTPException(400, detail={"code": "bad_pdf", "message": "That wasn't a PDF."})
        if len(data) > MAX_PDF_BYTES:
            raise HTTPException(413, detail={"code": "too_big", "message": "That pattern is too large to print."})
        opts = {"job_name": f"sewing:{kind}"[:120], "copies": _clamp(copies, 1, 5)}
        await run_in_threadpool(_preflight, uri, opts)
        result = await run_in_threadpool(ipp_print, data, uri, opts)
    except PrinterError as e:
        raise HTTPException(502, detail={"code": e.code, "message": e.message})
    finally:
        _lock["busy"], _lock["t"] = False, time.monotonic()
    return {"ok": True, "kind": kind, **result}


@app.get("/print/status/{job_id}")
async def print_status(job_id: int):
    uri = resolve_printer_uri()
    try:
        state = await run_in_threadpool(job_status, uri, job_id)
    except PrinterError as e:
        raise HTTPException(502, detail={"code": e.code, "message": e.message})
    return {"job_state": state, "label": JOB_STATE_LABEL.get(state, "working"),
            "done": state in JOB_STATE_DONE, "needs_attention": state in JOB_STATE_ATTENTION}
