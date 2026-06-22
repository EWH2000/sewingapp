# Sewing

Author sewing patterns and **print them at home at exact 1:1 scale** (tiled across
US-Letter sheets) or save them for later. A phone-friendly web app for the
household, served from the home hub at **`command.home.arpa/sewing/`**.

Built for someone who sews from purchased PDF patterns and wants to make her own.
First focus: bags (a parametric **boxy tote**), growing toward garments.

## What works
- **Boxy tote template** — enter the finished width × height × depth (+ seam
  allowance and strap size) and get a full tiled pattern: front/back, sides, base,
  and straps, each with a cut line, a seam-allowance stitch line, a grainline, and a
  label. Plus a **simple rectangle** tool.
- **Print at home, true to size** — PDFs are generated in the browser (pdf-lib) and
  relayed straight to a networked printer over **direct IPP** (`print-scaling=none`
  = exact 1:1) — no CUPS, no drivers, no root. Or **download** the PDF.
- **Calibration-first** — a one-time test page confirms a new printer prints true
  before any pattern is allowed to print.
- **Save patterns** — stored server-side in SQLite (backed up nightly), so they
  sync across her devices.

## How it's built
FastAPI + Jinja2 + SQLite, one rootless-podman container (systemd-user quadlet),
reverse-proxied by Caddy. **PDFs are generated in the browser** (vendored pdf-lib,
no build step); the **server stores the pattern documents and relays bytes to the
printer over IPP** (`app/printing.py`, pure stdlib). See **`CLAUDE.md`** (full app
guide), **`DESIGN.md`** (architecture + decisions), **`PRINTING.md`** (the verified
direct-IPP print design), and **`deploy/README.md`** (install/operate).

## Layout
```
app/            FastAPI app: main.py, printing.py (IPP), db.py, models.py,
                templates/, static/ (css, js/pattern-pdf.js = browser generators,
                js/vendor/pdf-lib.min.js)
tools/          the physically-PROVEN reference generators + IPP CLI (de-risk
                artifacts): calibration/ (1:1 proof), tiling/ (tiled PDF + SPEC.md)
deploy/         Containerfile is at root; quadlet + nightly backup live here
Containerfile   production image
```

## Dev
```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8006     # serves at /
```
(In the container, `BASE_PATH=/sewing` makes the same image serve under the proxy.)

## Status
The 1:1 print spine is physically proven (single-page and tiled). The freeform
multi-piece editor, the 3D assembled preview, and a gravity garment-drape on a
parametric dress form are all done (see `CLAUDE.md` for the full milestone log).
**Next: the interactive garment-authoring UI** (draw curves/darts/notches + enter
body measurements on `/edit`) — see `HANDOFF-editor-authoring-ui.md`.

MIT licensed. A personal home-server project.
