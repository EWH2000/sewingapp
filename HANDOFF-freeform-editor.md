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

## Done 2026-06-21 (this session)
- **Blank-editor bug fixed** — `piecesFromDoc` returned pieces missing
  `notches`/`placements`/`cornerRadius`/`layout`, so opening a saved **box** tote threw
  in `drawPaths` → dead canvas. Now routed through `clonePiece`. (+ asset-version cache
  busting in `main.py`/templates: CSS/JS get `?v=<hash>` so an iPad never pins stale JS.)
- **Unselected pieces** are now a readable slate (`DIM=#5f6470`, 0.85 opacity, faint fill)
  instead of near-invisible pale gray — low-vision friendly.
- **Per-corner radius** — `nodes[].radius` wired to a "Round this corner" input on a
  selected corner; `pieceGeom` fillets each corner with its own radius (per-node loop over
  `mk.path.fillet`, falls back to the piece-wide `cornerRadius` when a node's is 0).
- **Board overlap warning** — overlapping pieces draw with a red cut outline (`WARN=#d4351c`)
  and a status nudge on manual drag (`computeOverlaps`/`warnIfOverlap`, AABB on board bboxes).
- **SVG/DXF export** — `G.exportBoard(doc, "svg"|"dxf")` (Maker.js `exporter.toSVG/toDXF`,
  mm units) + Export SVG/DXF buttons; exports the exact printed geometry (reuses `buildDoc`).
- Tests: `verify-editor-geom.mjs` now **68 assertions** (per-corner fillet, export, overlap
  predicate); tiler regression still green. Verified live through Caddy (Playwright):
  rounded corner, red overlap + warning, SVG/DXF downloads, zero console errors.

## What's left (deferred — pick with the user)
- **True pocket↔panel linking** — a placement guide that references an actual pocket
  piece (so editing the pocket updates the guide). (Scoped out this session.)
- Per-corner-radius **sharp override** — today a piece default can't be overridden to
  "sharp" at a single corner (node radius 0 = inherit); a `-1`=sharp sentinel would fix it.
- Export polish — text-label layers / per-kind SVG colors (v1 exports geometry only).
- Other candidates raised along the way: curved edges (Bézier handles, not just
  rounded corners); garment templates (the FreeSewing-core era — DESIGN.md's trigger
  for finally adding a build step).

---
## New asks for this session
> _(owner: add what you want built next here)_
