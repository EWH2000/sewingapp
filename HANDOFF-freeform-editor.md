# Handoff — the freeform pattern editor

> **For the next session.** Start in `~/sewingapp/`. Read `CLAUDE.md` (app guide),
> `DESIGN.md` (architecture + locked decisions), and `PRINTING.md` (print design)
> first — then this. The app is live at `command.home.arpa/sewing/` (container
> `sewingapp`, port 8006). The freeform editor (DESIGN.md build-steps 6–9) is
> **built, verified, and deployed.** This doc is the current state + what's left.

## Status at a glance (all DONE + deployed 2026-06-20)
The "draw your own" layer is the third of the three document layers (template
*produces* a doc ✅ · **editor *edits* a doc** ✅ · printer *consumes* a doc ✅,
physically proven). Shipped, in order:

1. **Steps 1–2** — `/edit` SVG canvas (Draw tab) edits one closed polygon: drag /
   add / delete points, 5 mm grid snap, live edge lengths, numeric entry, undo/redo,
   pinch/wheel zoom + pan → save (`kind:"freeform"`) → print/download 1:1 via the
   **unchanged** tiler.
2. **Widescreen layout** — canvas + control-rail (no scrolling to reach params).
3. **Multi-piece** — a freeform doc is a list of **pieces** (front/back/side/base/
   strap/pocket…), each its own closed polygon, edited one at a time and packed into
   the tiled layout. Opening a saved **tote** (`box`) imports it as editable pieces.
4. **Step 3 — rounded corners + seam allowance (Maker.js).** Per piece: uniform
   corner radius (`chain.fillet`) + inset stitch line (`model.outline`), both
   flattened to polylines (`chain.toKeyPoints`, chord err ≤0.35 mm) so the line-only
   tiler stays untouched. Falls back to straight cut lines if Maker.js is absent.
5. **Notches + pocket-placement guides** — per piece: notch ticks (a point
   re-projected to the nearest edge → perpendicular ~7 mm tick; **Notch** mode) and
   dashed placement-guide rectangles with a label (add / drag / numeric W·H·X·Y).
   Both reuse existing tiler line-kinds (notch→`cut`, placement→`seam`).
6. **Whole-bag overview + click-to-edit (board layout)** — the canvas shows **every
   piece at once** on a shared board (`piece.layout {x,y}`). Tap a piece → select +
   zoom to it; **Show all** → zoom back out; drag a piece → arrange (snaps to grid);
   **Auto-arrange** → shelf-pack. **WYSIWYG: the arrangement is what prints.**

## The architecture (so you don't relearn it)
- **The print path is sacred and DONE.** The editor only has to emit a valid pattern
  document; `makeTiledPdf(doc)` in `app/static/js/pattern-pdf.js` does the rest
  (tiled, registration-marked, 1:1 PDF → server relays over IPP). **Never touch** the
  tiler / its self-assertions, `app/printing.py`, the calibration gate, the print
  lock, or the SSRF guard.
- **The shared document** (what the tiler reads): `{ name, kind, widthMm, heightMm,
  paths:[{kind:"cut"|"fold"|"seam"|"grain", points:[[x,y]…]}], labels:[…], params }`.
  Coordinates are **mm, bottom-left origin, y-up**. The tiler only draws
  straight-segment polylines (Liang–Barsky clip) — **all curves are flattened before
  they enter `paths`.**
- **Freeform doc = `params.pieces[]`** (schema 2). Each piece:
  `{id,name,count,seamMm,cornerRadius,closed, nodes:[{x,y,radius}],
  notches:[{x,y}], placements:[{x,y,w,h,label}], layout:{x,y}}`.
  **Node coords are LOCAL to the piece; board coord = local + `layout`.** The whole
  doc is stored in `Pattern.params_json` (no migration); `patternFromSaved` returns
  it as-is for freeform. Schema-1 single-shape docs still load (→ one piece);
  layout-less docs auto-arrange on load.
- **Three coordinate frames:** WORLD = board mm (y-up) · SCREEN = SVG px (y-down) ·
  camera `{k,tx,ty}`. SVG geometry group uses `matrix(k,0,0,-k,tx,ty)` +
  `vector-effect:non-scaling-stroke`; handles/labels live in an identity overlay.

## The files
| Path | What |
|---|---|
| `app/static/js/pattern-geom.js` | **`window.PatternGeom`** — pure, headless-tested geometry; the **only** Maker.js consumer. `pieceGeom` (fillet+seam→polylines, with fallback), `pieceExtras` (notches/placements), `packLayouts` (shelf-pack), `freeformToDoc` (layout-aware → tiler doc), `piecesFromDoc`, coordinate/snap/hit helpers. |
| `app/static/js/editor.js` | The `/edit` UI (SVG canvas in **board space**). Renders all pieces (active = full ink/fill/handles; others dimmed + named + tappable). Per-piece geom **cache** (Map keyed by piece) keeps pan/zoom off Maker.js. Pointer modes: drag vertex / drag placement / drag piece / pan / pinch; tap-to-select+zoom. |
| `app/static/js/vendor/browser.maker.js` | Maker.js 0.10.3 browser bundle (the only prebuilt single-file build; installs global `require`). |
| `app/static/js/vendor/maker-shim.js` | normalizes `require("makerjs")` → `window.makerjs`. |
| `app/templates/edit.html` | canvas + rail; loads vendor → shim → pattern-geom → editor (defer); injects `window.SEWING_EDIT`. Toolbar (Undo/Redo/Snap/Notch/Delete/readout/Show all), Pieces card (Auto-arrange / + Add piece), numeric card, actions. |
| `app/main.py` | added `GET /edit` and `GET /edit/{pid}` (active_tab "draw"; 404 if missing). No persistence change. |
| `app/static/js/app.js` | `patternFromSaved` freeform branch; `saved-edit` → `/edit/{id}`. |
| `app/templates/{base,index}.html` | Draw tab (3-tab bar); "Draw your own" card + Edit button for `freeform`/`rectangle`/`box`. |
| `tools/tiling/verify-editor-geom.mjs` | **headless harness** (56 assertions): geometry + fillet/seam/notch/placement/multi-piece + board layout. `tools/tiling/package.json` pins `makerjs@0.10.3` + `pdf-lib`. |

## How to work / verify
```bash
# headless geometry tests (run from tools/tiling — node_modules lives there):
cd ~/sewingapp/tools/tiling && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code is baked into the image — rebuild after edits):
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- **No root needed** (high port, rootless, all `systemctl --user`).
- **Can't run `sudo`** here — if a root step ever comes up, hand the user exact
  commands for their root SSH session.

## Verification state (last run, all green)
- 56 headless assertions PASS (incl. `packLayouts` non-overlap; `freeformToDoc`
  honors explicit layouts → board 400×150, pieces 300 mm apart; legacy back-compat).
- Tiler regression `verify-browser-gen.mjs` ALL PASS (`pattern-pdf.js` untouched).
- Live round-trip: arranged bag (Body@[0,0], Pocket@[340,0]) saved → read back
  (layouts preserved) → tiled 2×3. Test row cleaned up.
- **Only untested-by-machine surface: SVG pointer interaction on a real iPad** (no
  headless browser). See the manual pass below.

## Manual browser pass (do this once on the iPad)
`/sewing/edit` → open a saved tote from Home → all pieces spread on the board → tap
one (zooms in to edit) → drag a corner / add a notch / add a pocket guide → drag a
piece to rearrange → **Auto-arrange** → **Show all** → Save → reload (arrangement
preserved) → Download → PDF matches the on-screen layout.

## Don't-break checklist
- `makeTiledPdf` must keep passing its self-assertions (612×792, no rotation,
  CropBox==MediaBox, ink in the ≥13 mm keep-out). Run `verify-browser-gen.mjs` after
  any `pattern-pdf.js` touch.
- Calibration-first gate, SSRF guard, print lock in `main.py`/`printing.py`.
- Notches/placements must keep reusing existing line-kinds (`cut`/`seam`).
- Maker.js loads **only on `/edit`**; Home never loads it (prints stored flattened
  paths). `pieceGeom` must keep its no-Maker.js fallback.
- BASE_PATH on every emitted URL and `fetch()`.

## What's left (deferred — none started; pick with the user)
- **SVG/DXF export** — nearly free now via `makerjs.exporter` (give her files to send
  to a shop / cutter / import elsewhere).
- **Per-corner radius** — today radius is uniform per piece; `nodes[].radius` already
  exists in the model, just not wired to per-node UI/geom.
- **Overlap warning** on the board (arrangement allows overlap by design; warn so she
  doesn't waste paper).
- **True pocket↔panel linking** — a placement guide that references an actual pocket
  piece (so editing the pocket updates the guide).
- Other candidates raised along the way: curved edges (Bézier handles, not just
  rounded corners); garment templates (the FreeSewing-core era — DESIGN.md's trigger
  for finally adding a build step).

---
## New asks for this session
> _(owner: add what you want built next here)_
