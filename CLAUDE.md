# sewingapp — pattern authoring + 1:1 home printing

A phone-friendly tool for the household to **author sewing patterns** and **print
them at home at exact 1:1 scale** (tiled across US-Letter sheets) or save them for
later. Built for the owner's partner, who sews from purchased PDF patterns; this
authors *new* ones. First focus: bags (boxy tote), evolving toward garments.

Hub tile **"Sewing"** (scissors) → `/sewing/` → **:8006**. House-styled like the
other apps. See `DESIGN.md` (architecture + decisions), `PRINTING.md` (the
verified direct-IPP print design), and `PREVIEW.md` (**plan-only** roadmap for a 3D
assembled-product preview → garment cloth-drape). Server-wide rules: `~/CLAUDE.md`.

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
lines, grainlines, labels — `boxyTotePattern`) + a simple rectangle.

**Freeform editor steps 1–2 DONE (2026-06-20).** A `/edit` SVG canvas (Draw tab)
edits ONE closed polygon — drag/add/delete points, grid snap, live edge lengths,
numeric entry, undo/redo, pinch/wheel zoom + pan — then saves (`kind:"freeform"`,
whole doc in `params_json`) and prints/downloads 1:1 via the unchanged tiler.
New: `app/static/js/pattern-geom.js` (pure, headless-tested geometry —
`window.PatternGeom`), `app/static/js/editor.js` (UI), `app/templates/edit.html`,
`tools/tiling/verify-editor-geom.mjs`. `patternFromSaved` got a `freeform` branch.
The tiler/`printing.py`/calibration gate were NOT touched.

**Multi-piece bag builder added (2026-06-20).** A freeform doc is now a list of
**pieces** (front/back/side/base/strap/pocket…), each its own closed polygon, edited
one at a time and **auto-packed** into the tiled layout by `freeformToDoc` (shelf-pack
like the tote). The `/edit` rail has a Pieces panel (add / duplicate / rename / cut-count
/ delete / select) and a **widescreen** canvas-+-rail layout. Opening a saved **tote**
(`box`) imports it as editable pieces (`G.piecesFromDoc`). `params` schema bumped to 2
(`pieces[]`); schema-1 single-shape docs still load (→ one piece).

**Step 3 DONE (2026-06-20) — rounded corners + seam allowance (Maker.js).** Vendored
`app/static/js/vendor/browser.maker.js` (the 0.10.3 browserify bundle — only prebuilt
single-file build; newer npm has no browser bundle) + `maker-shim.js` (its global
`require` → `window.makerjs`), loaded only on `/edit` before `pattern-geom.js`. Per piece:
**Round corners** (uniform radius → `chain.fillet`) and **Seam allowance** (inset stitch
line → `model.outline(...,inside)`), both flattened to polylines via `chain.toKeyPoints`
(adaptive facet, chord err ≤0.35 mm) so the **line-only tiler stays untouched**. All in
`G.pieceGeom(piece)` with a **fallback** to straight cut lines if `window.makerjs` is
absent (Home never loads it — it prints stored flattened paths). Over-large SA is guarded
(seam omitted, editor warns). Node tests use `makerjs@0.10.3` (in `tools/tiling`, matches
the bundle).

**Notches + pocket-placement guides DONE (2026-06-20).** Per piece: `notches:[{x,y}]`
(a point that re-projects to the nearest edge → a ~7 mm perpendicular tick; **Notch** mode
toggle: tap edge to add, tap tick to remove) and `placements:[{x,y,w,h,label}]` (a dashed
guide rectangle, e.g. where a pocket attaches — "+ Pocket guide" button; tap to select,
drag to move, numeric W/H/X/Y + label, Remove). Both reuse existing tiler line-kinds
(notch→`cut`, placement→`seam`) so `pattern-pdf.js` stays untouched; emitted by
`G.pieceExtras` inside `freeformToDoc`.

**Whole-bag overview + click-to-edit DONE (2026-06-20).** The canvas now shows **every
piece at once** on a shared **board** (each piece has `layout:{x,y}`); the selected piece
is editable in place, the others are dimmed + named + tappable. **Tap a piece → select +
zoom to it**; **Show all** zooms back out; **drag a piece** to arrange it (snaps to grid);
**Auto-arrange** packs them. **WYSIWYG: the arrangement is what prints** — `freeformToDoc`
places each piece at its `layout` (packs any missing) and normalizes the board; `G.packLayouts`
is the shelf-packer. Editor world = board space (node board = local + `piece.layout`); a
per-piece geom cache keeps pan/zoom off Maker.js. Backward-compatible: layout-less docs
auto-arrange on load. **Next: SVG/DXF export (free via `makerjs.exporter`); per-corner
radius; overlap warning; true pocket↔panel linking.** Interaction (SVG drag UX on iPad) is
the only part not auto-tested — verify by drawing.

**3D assembled preview — M0–M3 + strap handles DONE; owner gate cleared on her touchscreen laptop (2026-06-21); M4 next.** Full build spec in
`PREVIEW.md`: an in-browser three.js preview of the *sewn-up* product, on the road to a
soft-body **garment cloth-drape** (the real goal — she's making skirts + tank-style
dresses; sleeveless-first by design, sleeves are an additive M6 escape hatch, nothing
thrown away). Keystone = a new top-level **seam graph** (`seams[]`, schema 2→3, additive,
no DB migration). Three steps / six milestones (M0–M6): box preview → seam authoring +
rigid spanning-tree fold → XPBD cloth drape on a procedural parametric dress form.
Architecture inherited unchanged: browser-side geometry, **no build step** (three.js via
native import map; hand-rolled pure-JS solver — deliberately doesn't trip DESIGN.md's
FreeSewing build-step trigger), server stays a dumb store/relay, **print spine + the
calibration gate untouched** (preview is read-only of the doc). Lives on a separate
`/preview/{id}` page with a separable Step-3 module. **M0 + M1 DONE:** `/preview/{id}`
renders the assembled bag in 3D via a no-build three.js import map (vendored r184 in
`app/static/js/vendor/three/` — `three.module.js` + `three.core.js` + `OrbitControls`,
loaded only on `/preview`; route mirrors `/edit`; `preview.js` ESM entry + `preview3d.js`
`docToMesh`, headless-tested by `tools/preview/verify-box-mesh.mjs`). A boxy tote previews
as a correctly-proportioned, pattern-textured box (per-face `CanvasTexture` from
`pieceGeom`) with flat leather straps + a studio **atelier** look (DESIGN.md "Visual
identity"). Also this session: **app-wide display units default to inches + cm (mm dropped)**,
persisted in `localStorage["sewing.unit"]`, shared by home/editor/preview — the document
stays in mm, so the print spine + calibration gate are untouched. **M2 DONE:** a top-level
**`seams[]`** graph (schema 2→3, additive; `EdgeRef {piece:<id>, edge:i}` with stable/unique
piece ids; `G.normalizeSeams` drops dangling refs; headless-tested in `tools/tiling/verify-
seams.mjs`) authored via a new **Sew mode** in `/edit` (tap an edge on one piece, then a
matching edge on another → a seam; per-seam fold-angle preset; round-trips through save +
undo/redo). **Deferred to M3+:** notch `{edge,t,type}` upgrade + anchors UI, dart authoring/
self-seams, seam flip — and the preview doesn't *consume* seams yet. **M3 DONE (2026-06-21):**
the preview now **folds a freeform bag up** from its seam graph. `app/static/js/pattern-fold.js`
(pure/headless `window.PatternFold.foldDoc`): spanning-forest BFS + forward kinematics + a
Levenberg–Marquardt closure solve for the cyclic seams; **per-seam direction (head-to-tail vs
head-to-head) is SEARCHED** for the assignment that closes (a box and a tube need opposite
conventions — not a fixed default); degrade-never-blank ladder (`closed`/`open`/`tree`). Renderer
in `preview3d.js` (additive — box path byte-identical): `ShapeGeometry` faces placed by each
piece's `{pos,quat}`, `pieceFaceTexture` (true outline, UV-registered), dashed gap seams for
unclosed cycles, and an **outward-normal UV flip** so inward-facing panels' pattern text reads
forward (not mirror-reversed). `preview.js` routing + fold readout + a **Floor-piece override**
(auto-detect the base by hinge-degree, with a persisted additive `foldRoot` to correct it);
Sew-mode **flip-direction toggle** (`anchors`). Headless tests `tools/preview/verify-fold.mjs`
(33) + `verify-fold-mesh.mjs` (9); print spine/calibration gate/M1 box untouched. **Refinements
vs the handoff:** root = max hinge-degree (largest area picks a wall on a tall tote); tote cycle
count = 4; PREVIEW.md §3.6(a)'s tote JSON has an edge-index slip (pairs a 250 mm edge to a 120 mm
one — `verify-fold.mjs` uses the consistent verticals). **STRAP INTEGRATION DONE (2026-06-21):**
a freeform bag's strap now renders as **flexible arched leather handles** on the folded bag, not a
flat panel. `pattern-fold.js` gains a pure `isStrapPiece` (role → name → long-&-thin-with-short-end-
seams) and pulls strap pieces + their seams OUT of the rigid fold *before* classification (a length-
mismatched strap seam used to be `nonHingeable` and degrade the WHOLE bag to `tree`); the bag closes
unchanged and `foldDoc` returns an additive `straps:[{piece,lenMm,widthMm,anchors,widthDir,grab,...}]`.
`preview3d.js` `addStraps` arches a leather band (`archCurve` bisects apex height so arc-len ≈ strap
length) per handle: a **grab** handle (both ends on one edge) is a planar rainbow in its panel plane;
a **span** handle (ends on two edges, e.g. side-to-side over the top) **sweeps its width ALONG the
bag edges** (`widthDir`) so it meets the seams square, not twisted; a count×2 grab handle auto-mirrors
to the opposite face. Additive per-piece **`role`** (`clonePiece`+editor `restore`+a Pieces-panel
**Type: Auto/Panel/Strap** select). `strapRibbonGeometry` gained an optional `frame` ({normal}|
{widthDir}) — the box ribbon path stays byte-identical. Tests: `verify-fold.mjs` (59) +
`verify-fold-mesh.mjs` (15); box-mesh/print spine/calibration gate untouched. **Still deferred:**
count×2 *span* renders one handle (not a parallel pair); strap bands are plain leather (no pattern
texture); notch `{edge,t,type}` + anchors UI; dart self-seams; atelier re-skin. **Next: M4** (Step 3a
inflated bag). Build-tracking + locked decisions live in `HANDOFF-3d-preview.md` + `PREVIEW.md`;
`HANDOFF-strap.md` was the strap starting orders, `HANDOFF-M3-fold.md` the M3 ones.
