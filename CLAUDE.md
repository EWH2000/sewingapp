# sewingapp — pattern authoring + 1:1 home printing

A phone-friendly tool for the household to **author sewing patterns** and **print
them at home at exact 1:1 scale** (tiled across US-Letter sheets) or save them for
later. Built for the owner's partner, who sews from purchased PDF patterns; this
authors *new* ones. First focus: bags (boxy tote), evolving toward garments.

Hub tile **"Sewing"** (scissors) → `/sewing/` → **:8006**. House-styled like the
other apps. See `DESIGN.md` (architecture + decisions) and `PRINTING.md` (the
verified direct-IPP print design). Server-wide rules: `~/CLAUDE.md`.

## Stack (mirrors cercoachapp)
FastAPI + Jinja2 + SQLite (sqlmodel), one rootless-podman container via a
systemd-user quadlet, `BASE_PATH=/sewing` so one image serves at `/` (dev) and
`/sewing/` (behind Caddy). **Same pinned `requirements.txt` as the sibling apps —
zero extra deps** (the IPP client is pure stdlib).

## The key architectural split (important)
- **PDFs are generated in the BROWSER** with vendored pdf-lib
  (`app/static/js/pattern-pdf.js`, a port of the *physically proven* generators in
  `tools/`). The browser builds the exact-scale tiled PDF from the pattern document.
- **The server stores + relays.** It persists pattern documents (SQLite, backed up)
  and, on "Print at home", receives the generated PDF and **relays it straight to
  the networked printer over IPP** — `app/printing.py`, a stdlib port of
  `tools/calibration/ipp-print.mjs`. **No CUPS, no drivers, no root.** It always
  sends `print-scaling=none` (the 1:1 guarantee) + the full verified attribute set.

So: geometry/PDF = browser; persistence + printing = server. Don't move PDF
generation server-side (would need Node or a reportlab re-port + dual maintenance).

## Files
| Path | What |
|---|---|
| `app/main.py` | routes: pages, pattern CRUD, `/settings/printer`, `/printer/test`, `/printer/calibrated`, `/print`, `/print/status/{id}`, `/health` |
| `app/printing.py` | **pure-stdlib IPP** — build/parse, `ipp_print`, `validate_job`, `get_printer_state`, `job_status`, SSRF guard (`validate_printer_uri`) |
| `app/models.py` | `Pattern` (the JSON doc) + `Setting` (printer_uri, `calibrated:<uri>`) |
| `app/db.py` | SQLite engine + `get_setting`/`set_setting` |
| `app/static/js/pattern-pdf.js` | **in-browser** calibration + tiled PDF generators (`window.PatternPDF`) |
| `app/static/js/app.js` | UI glue: generate → print(multipart)/download, status poll, settings |
| `app/static/js/vendor/pdf-lib.min.js` | vendored pdf-lib UMD (`window.PDFLib`); no build step |
| `app/templates/` | `base.html` (house head + nav), `index.html`, `settings.html` |
| `tools/` | the **proven reference** generators (`calibration/`, `tiling/`) + the IPP CLI; the de-risk artifacts. Keep as the canonical geometry reference. |
| `deploy/` | quadlet + nightly backup (timer at 03:45) + README |

## The calibration-first gate (don't remove)
True 1:1 can't be assumed for a *new* printer. Per printer URI, a `calibrated:<uri>`
flag gates real-pattern printing: until she prints the test page, measures it, and
taps **"It measured right"**, only the calibration page prints (download always
works). On this box's HP LaserJet Pro (192.168.8.198) 1:1 is physically confirmed.

## Dev / deploy
```bash
# dev (BASE_PATH unset → serves at /):
.venv/bin/uvicorn app.main:app --reload --port 8006
# build + run the real container:
podman build -t sewingapp . && systemctl --user restart sewingapp
# after editing the quadlet: systemctl --user daemon-reload then restart
# Caddy route /sewing/ + the hub tile are already wired (see ~/caddy/).
```
Code is baked into the image (`COPY app/`), so **rebuild + restart after edits** —
not live-mounted. SQLite + settings live on the `sewingdata` named volume.

## Status (2026-06-20)
App shell DONE + verified end-to-end (pages, hub tile, proxied path, pattern CRUD,
printer-test IPP parse, SSRF guard, print guards, a real print through `/print`).
Print spine physically proven (single-page + tiled 2×2). Authoring surface:
**boxy-tote template** (front/back/sides/base/straps with seam allowance, stitch
lines, grainlines, labels — `boxyTotePattern`) + a simple rectangle. **Next: the
freeform editor** over the shared pattern document, then more templates + SVG/DXF.
