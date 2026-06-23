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
`verify-fold-mesh.mjs` (15); box-mesh/print spine/calibration gate untouched. A count×2 *grab*
strap mirrors to the opposite face; a count×2 **span** strap is a SINGLE bridging handle (count is
just cut quantity — it no longer renders a parallel pair; fixed 2026-06-21). **Still deferred:**
strap bands are plain leather (no pattern texture); notch `{edge,t,type}` + anchors UI; dart
self-seams; atelier re-skin.

**M4 / Step 3a — inflated 3D bag DONE (2026-06-21, owner gate cleared on her touchscreen laptop).**
A freeform-with-seams bag now previews as a sewn, **inflated**, orbitable soft bag (the default view
on `/preview/{id}`; a **Fold ⇄ Inflated** toggle keeps the rigid M3 fold). Hand-rolled XPBD mass-spring
solver `app/static/js/pattern-cloth.js` (pure/headless `window.PatternCloth.solveDrape`): warm-starts
each non-strap piece's sim mesh from the M3 fold's `{pos,quat}`, derives per-seam sew direction from
the warm start (mirrors `inferFlip`), then runs the §6.6 protocol — zero-gravity eased stitch-up (seam
compliance `1e-1→1e-6`, per-substep node-move clamped to `0.5·h`) → **per-face outward "puffiness"
pressure** (open-top safe; orient outward by the bag node-centroid) bounded by a **per-node inflation
tether** (≤5% of the bag diagonal — so it ROUNDS, never balloons, regardless of pressure: the
robustness win) → settle/freeze on low motion. Deterministic (no RNG); ~1–4k nodes; settles in
~0.3–0.6 s. Render: additive `preview3d.drapeToGroup` — **pattern-textured per-piece** sub-geometries
(UVs from `localUV` over the authored-nodes bbox, per-piece outward U-flip), straps ride on top via the
unchanged `addStraps`. Page: **Preview detail Draft/Standard/Fine** (`h` 25/20/15), the Fold⇄Inflated
toggle, a **"Settling…"** badge (double-rAF so it paints before the blocking solve), and a **settled-mesh
cache** in the doc (`params.preview3d`: int16@0.1mm + base64, `geomHash`-keyed — instant reopen,
re-solves only on an edit/detail/floor change; opaque `params_json`, no server change). `pattern-cloth.js`
also exports `geomHash`/`encodeDrape`/`decodeDrape`. Box/M3-fold paths + print spine + calibration gate
byte-identical. Tests: `tools/preview/verify-cloth.mjs` (26) + `verify-cloth-mesh.mjs` (18); the prep
layer (`verify-mesh.mjs` 15 / `verify-seam-correspondence.mjs` 16) + `verify-fold.mjs` (61) /
`verify-fold-mesh.mjs` (15) stay green. **Strap SNAP-TO-SURFACE DONE (2026-06-22, owner gate cleared):**
the drape view snaps each handle anchor from the folded rim to the nearest settled surface node
(`preview3d.snapToSurface`), so the handle attaches flush to the inflated bag (the fold view keeps the
raw rim anchors). **Deferred — NEXT:** welding/true-volume, plain-leather strap texture — all leaning
into **M5** (Step-3b garment on a lofted dress form). Build-tracking + locked decisions live in `PREVIEW.md`
§9 (the per-milestone starting-orders handoffs have been retired into this status + `PREVIEW.md`; git keeps them).

**M5a / Step-3b garment AUTHORING foundation DONE (2026-06-22, owner-gated — she confirmed the seeded
garments print + look right; flat-laying preview understood as expected pre-form/gravity).** The doc can
now *represent* a dress, with every new feature **lowering to the existing `cut`/`seam` line-kinds inside
`pieceGeom`/`pieceExtras` BEFORE `freeformToDoc` builds `paths`** — print spine (`pattern-pdf.js`/
`printing.py`/calibration gate/SSRF guard) byte-identical; schema-2 docs unchanged; `params_json` still
opaque (no DB migration). Schema bumps to **3** only when a schema-3 field is present. New in
`pattern-geom.js`: **curves** (sparse `edges:{"<i>":{curve:{type:"quad"|"cubic"|"arc",cp:[…]}}}` in the
edge-local frame, flattened via Maker.js `BezierCurve`/`Arc` in the *same* `pieceGeom` flatten print +
drape share); **darts** (`piece.darts:[{id,edge,center,width,depth,kind}]`; a pure `G.loweredBoundary(piece)`
splits a wedge edge + drops an apex into the cut outline **without mutating `piece.nodes`** so edge identity
is stable; slash darts draw fold guides — darts live in `darts[]` only, NOT derived into `seams[]`, see the
m5a-dart-representation memory); **variable per-node SA** (`node.saMm`, guarded miter-offset; uniform SA
byte-identical); **notch upgrade** `{edge,t,type}` (single/double ticks; legacy `{x,y}` migrates on save);
doc-level **`body:{heightMm,bustMm,waistMm,hipMm}`** passthrough (defaults `1650/920/740/980`). `editor.js`
data-preservation: `restore` routes through `normalizePieces` (carries curves/darts/notches/SA through undo)
+ `body` round-trips load/save/undo (the interactive authoring UI — curve drag-handle, dart/notch/measurements
panels — is the deferred next chunk; the data model + print lowering are done so it's additive). `main.py`
gains an additive read-only `GET /patterns` list route. **`tools/seed-examples.mjs`** (host-side, idempotent)
seeded **id 5 A-line Skirt, id 6 Tank Bodice, id 7 Tank Dress** (curves + darts + seams + body); existing
bags id 3/id 4 untouched. The seeded bodice tiles to a valid 8-sheet 0-bad-page **true-1:1 Letter PDF**.
Tests: `verify-editor-geom.mjs` (85) + `verify-seams.mjs` (27) extended, new `tools/preview/verify-lowering.mjs`
(16); full headless suite green.

**M5b / Step-3b parametric DRESS FORM DONE (2026-06-22, owner-gated — "body and form editor work well").**
A garment preview now shows a translucent **dress form** sized from the doc's `body` measurements, with a
live **Measurements panel**. New pure `app/static/js/body-form.js` (`window.BodyForm`, no three/DOM/RNG):
`loft(body,opts)→ringStack` lofts a limbless torso from a stack of **elliptical** rings (wider than deep,
`ASPECT 0.72`); each band's semi-axis is solved **closed-form** from its target circumference (Ramanujan's
perimeter approx inverts to a constant `ellipseK(r)` at fixed aspect → re-loft <1 ms), Hermite-interpolated
over an 8-band silhouette (waist pinch + bust peak); height scales the Y extent, girths stay put; the form's
hem sits on the floor (y=0). **Analytic collision** (no SMPL/SDF, ready for M5c): `insideForm`,
`nearestSurface` (horizontal-only push + skin offset), `signedDist`, `ringAt`. `preview3d.js` adds
`dressFormGeometry`/`dressFormGroup` (translucent pale-muslin `MeshStandardMaterial`, 48×48 + caps, smooth
normals; **`group.userData.stack` is the SAME stack the M5c solver will collide against** so render + collision
can't drift). `preview.html` loads body-form.js (classic defer) + a `#pv-measure` plate; `preview.js` builds
the form for any garment (doc has `body`), frames the form+garment union, and re-lofts live on edit
(debounced save; the doc is mm, opaque `params_json`). The garment still lies flat (drape onto the form is
M5c). Tests: `tools/preview/verify-body-form.mjs` (31 — circumferences match measurements, aspect asymmetry
catches an a/b swap, height scales Y, insideForm/nearestSurface, re-loft, no overshoot, determinism, the
translucent render); full suite green.

**M5c / Step-3b GRAVITY GARMENT DRAPE — basic drape DONE (2026-06-22, owner-gated — garments hang
believably on the form).** A garment (doc with `body`) now **drapes under gravity ON the dress form**
instead of lying flat. `pattern-cloth.js` `solveDrape` gains an **`opts.garment` branch** (the bag inflate
path is byte-identical when off — `verify-cloth.mjs` 26 green): **warm start = `placeGarment` wraps each
flat panel around the form** (front panel → front-half ellipse at its band height, skirt → hangs from the
waist by its own height; pushed just outside the surface; robust to hand-authored naming + role; finishing
strips/straps excluded; degrade-never-blank falls back to the fold); **gravity** replaces inflation pressure
in the substep integrate (mass-independent — heavy fabric resists folding, doesn't fall slower; pins
excluded; true scale `9810·dt²` < the `0.5h` clamp); **one-sided analytic body collision** (`BF.insideForm`→
`nearestSurface`, horizontal push + pseudo-friction grip); **pins** the top edge (shoulders/waistband) so it
hangs from its support; **fabric presets** (`FABRICS` cotton/linen/silk/denim → stretch/bend compliance +
node mass). `geomHash` grows with body/fabric/garment (bag hash byte-identical). The form is repositioned to
**float at anatomical heights** (hem ~0.42·height, shoulder ~0.84·height) so a skirt has room to hang.
Preview: garments route to the garment drape, a **Fabric** control (`#pv-fabric`), the toggle reads
**"Draped"**. Verified host-side on all 3 seeded garments: **0% cloth inside the body**, each hangs from its
support. Tests: `tools/preview/verify-garment-drape.mjs` (15) + body-form repositioned (34); full suite green.
**NEXT (M5c-step2): the bust dart shapes the bodice** (triangulatePiece cuts the wedge + selfSeamPairs sews
the legs), then self-collision + settle tuning.

**M5c-step2 / DART SHAPING DONE (2026-06-22, owner-gated — "coming along great").** A wedge dart now
**shapes the bodice in 3D**: `triangulatePiece` routes a darted piece through `G.loweredBoundary` (cuts the
wedge from the sim mesh, tags the two legs in `boundaryMeta` `{dart,leg,t}`) — the no-dart path is
byte-identical, so bags/plain panels are untouched. `pattern-mesh.selfSeamPairs(mesh,dartId)` pairs the legs
(mouth→apex, A(t)↔B(1−t)); the garment `solveDrape` **WELDS** the pairs (`projectWelds`: snap each pair to its
midpoint every substep) — a spring let gravity reopen the dart (40→10mm in stitch-up, then back to 49mm under
gravity), the weld holds it shut (**2.1mm** under full gravity) and the darted front gains ~80mm front-back
depth vs flat (it shapes to the bust). `SIM_VERSION 1→2` invalidates pre-dart cached drapes (bags re-solve
once, byte-identical). Tests: `verify-garment-drape.mjs` 15→20 (dart legs tagged, paired, sewn shut under
gravity, front gains depth, no NaN); full suite green. **NEXT (M5c-step3): self-collision** (cloth-on-cloth,
final settle passes) **+ settle tuning** (the drape freezes "warm" — slightly wavy). Then the **interactive
editor authoring UI** (curve drag-handle / dart / notch / measurements on `/edit` — the data model + print
lowering already exist, so it's additive — starting orders in `HANDOFF-editor-authoring-ui.md`).

**M5c-step3 / BODICE-GAP FIX + "doesn't-fit" stretch-to-fit + warning DONE (2026-06-22, owner-gated — "that
fix worked, there are no more gaps").** The tank bodice drape showed gaps (the form peeking through), which was
**three compounding bugs**, all measured host-side: (1) **the shoulder seam was never sewn** — it lies inside
the pinned top-8% band, so both endpoints had `invm=0` and `projectDist` skipped it (frozen ~175 mm open); (2)
**the shoulder seams were mis-paired in the seed** (`e3↔e3` straight, but the mirror-wrapped back needs them
**crossed** `e3↔e5` like the sides); (3) **the bodice was child-sized** (front+back 520 mm around vs a 920 mm
body). Now the bodice closes to **~7 mm** (Standard) — owner confirmed no gaps. The fixes, all GARMENT-only
(bag inflate path byte-identical — `verify-cloth.mjs` 26/26; print spine/calibration gate untouched):
- **`pattern-cloth.js` solver** (`SIM_VERSION 2→3`, invalidates cached drapes): the zero-g stitch-up now runs
  **UNPINNED** so the top seam actually sews, then pins the stitched shoulder/waist line for the gravity phase
  (`pinNow` zeroes pin velocity AND pushes any pin that drifted inside the body back out — an open neckline
  would otherwise pin inside + clip forever; `opts.stitchUnpinned:false` rolls it back). A **bodice is pinned at
  BOTH shoulder + waist** so it doesn't droop to the wider hip (which split the side seam) — EXCEPT under a
  **dart mouth** (computed from the dart's edge geometry) so a waist dart still sews shut. A skirt stays
  top-pinned (hangs). **Bounded stretch-to-fit**: a final reconciliation phase (`seam2=1e-9` beats stretch)
  closes a seam by stretching the fabric, capped per-edge at +15% — so a too-small garment bridges instead of
  gapping. Warm-start sectors now **meet at ±90°** (side seams start coincident). An additive **`strain` metric**
  on the garment return (`{maxSeamGapMm, maxStretchRatio, overTension, wontClose, seams[], gapSegs[]}`) — fires
  `overTension` when a seam genuinely can't close (gap > **50 mm**, the threshold that clears the hanging-seam
  solver noise floor; a fitting bodice is ~7 mm, a fine skirt/dress side seam settles ~25–35 mm which is NOT a
  fit problem). `gapSegs` (flat world segments) ride the cache so the highlight survives a reopen.
- **`preview.js`**: persists/rehydrates `strain` through the settled-mesh cache; `fillDrapeSpec` shows a
  **"Doesn't close — pattern too small here (gap N mm)"** warn row when `overTension`. **`preview3d.js`**:
  `addStrainSeams` draws dashed red bridges on the draped mesh (modeled on `addGapSeams`), gated on
  `overTension`, headless-safe. **`preview.html`**: `.pv-spec__warn` atelier amber/brass CSS.
- **`tools/seed-examples.mjs`**: bodice re-scaled to a symmetric taper (waist 780 / bust 980 per the default
  body, neck gap 132) + shoulders crossed (id 6 + dress id 7); dress skirt waist widened to 390 to meet the new
  bodice waist; `SEED_OVERWRITE=1` updates id 5/6/7 in place (preserves ids; default run still idempotent-skip);
  builders exported (entry-point-guarded POST) for the new test. Re-seeded id 5/6/7 (host-side, no rebuild).
- Tests: `verify-garment-drape.mjs` rewritten (33 — shoulder+side close, strain quiet at fit + fires bounded
  when oversized, no body penetration, dart excluded from strain, skirt fixture, rollback flag); new
  `verify-seed-bodice.mjs` (18 — every inter-piece seam's edges match ≤2 mm, bodice fits, all examples still
  lower to a schema-3 print doc). Full headless suite green (print spine sentinels included).
**KNOWN LIMITATION (deferred to settle tuning, owner aware):** the **hanging skirt/dress side seam** doesn't
fully close near the form's lower edge (~26 mm dress hip / ~34 mm skirt at Standard, more at Fine) — a soft-body
limitation, NOT a fit problem, so it correctly does not warn. The bodice (pinned both ends) is the clean one.
**Still next:** self-collision + settle tuning (would also tighten the hanging seams); the interactive editor
authoring UI; revisiting the waist dart on a fitted body (the body now provides most of the bust shape).

**M5c-step4 / SELF-COLLISION + SKIRT-SEAM CLOSEUP + WAIST DE-JAG DONE (2026-06-22, owner-gated — "looks much
better, commit it").** Three garment-only additions in `pattern-cloth.js` (bag inflate path BYTE-IDENTICAL —
`verify-cloth.mjs` 26/0; explicit tote byte-diff = 0; print spine/calibration gate untouched), `SIM_VERSION 3→4`:
- **Cloth self-collision** (`projectSelfCollision`) — fixes the lower bodice CRUMPLING THROUGH ITSELF (no
  cloth-cloth collision existed before; measured 101 interpenetrating node pairs). A DETERMINISTIC uniform spatial
  hash (cell=h; integer key `(cx+OFF)+(cy+OFF)*B+(cz+OFF)*B*B`, OFF=1024/B=2048; buckets filled + swept by
  ascending node index — never Map/`for..in` order), a build-once exclusion `Set` of legitimately-joined pairs
  (triangle edges + stretch/bend/seam/dart-weld, key `i*N+j`, i<j), **inelastic contact** (positional split-by-invm
  push to `clothThick=0.5·h`, then remove the *approaching* relative normal velocity via `Pp` — separates without a
  pop and without re-ramming; a hard X-only push injects ≈vmax of outward Verlet velocity → jitter). Armed ONLY in
  the final `selfWindow=30` settle substeps + reconcile (cheap), `opts.selfCollide`-gated (default ON garments).
  Bodice interpenetrating pairs **101→8**, minNonAdj 0.64→4 mm.
- **Seam-closeup** (the free-hanging skirt/dress SIDE SEAM, prior known limitation) — the hem hangs BELOW the form
  in free space where no body molds it + full gravity splays the two edges, so the soft seam springs left ~34 mm.
  After settle: a closeup loop hardens the inter-piece seam soft→near-weld (`closeSeam1=1e-11`) under reduced
  gravity (`closeGrav=0.15`); reconcile runs at reduced gravity WITH the stretch clamp; then a low-gravity
  re-settle (`closeReGrav=0.2`, no clamp) holds the closure while the bulk drape (set at full gravity) relaxes the
  over-stretch. **Skirt side seam 34→1 mm, dress 26→11 mm**; p95 stretch dropped 1.68→1.21 as a bonus. Inert on an
  already-closed (body-molded) bodice seam.
- **Taubin λ\|μ surface smoothing** (`smoothSteps=6`, λ0.6/μ-0.63) — the owner's "jagged at the bottom" was sharp
  folds in a tight ring at the WAIST (the pinned+welded+skirt-seamed edges converge there + the fabric compresses;
  ~11 mm surface roughness vs ~2 mm elsewhere). Shape-preserving λ\|μ passes (μ<0 counters λ-shrink) iron it to
  ~2.7 mm. Adjacency BRIDGES the already-close seam/weld pairs (so it can't pull a closed seam open) + re-snaps
  them + body-reprojects; FAR pairs (oversized misfit) are left untouched so `overTension` still fires. Smooths
  the pinned waist line too (`smoothPins` — `pinNow` froze it jagged); shoulders shift only ~5 mm.
- The `mode` settled/warm verdict now uses the **p90** of per-node motion, not the worst node (one self-collision
  contact rails at `vmax` forever). A residual ~3-4 mm bulk jitter remains ("warm") — inherent solver under-
  resolution at this mesh density, owner-accepted (the visible defects are fixed). Tests: `verify-garment-drape.mjs`
  33→**46** (self-collision separates/deterministic/gated; smoothing lowers roughness + keeps seams closed +
  preserves the warning; geomHash re-keys on sc/thick/scw/sm, bag hash byte-identical). Full headless + print-spine
  suites green. **Still next:** the interactive editor authoring UI (curve/dart/notch/measurements on `/edit`);
  revisiting the waist dart on a fitted body.

**INTERACTIVE GARMENT-AUTHORING UI on `/edit` DONE (2026-06-22, owner-gated — "everything checked out").** The
owner can now **DRAW** garments (curves, darts, notch types, body measurements) instead of only getting them from
`tools/seed-examples.mjs`. Purely additive UI on `editor.js` + `edit.html` over the schema-3 model M5a already
lowers to `cut`/`seam` BEFORE the print spine — `pattern-pdf.js`/`printing.py`/calibration gate/SSRF guard
**byte-identical**, no DB migration, schema stays 2 until a schema-3 field is present. Built MVP-first; each chunk
owner-gated. Validated by a design + 3-lens adversarial workflow (it caught the sign convention, an undo bug, a
quad→cubic data-loss trap, board-explosion clamps, and the Bezier-lib bug below).
- **Foundation:** `pieceGeomCached` key now includes `edges`/`darts` (curve/dart edits were a silent no-op without
  it). New pure `pattern-geom` exports `worldToEdgeLocal` (exact analytic inverse of `edgeLocalToWorld`),
  `edgeInwardSign` (per-edge inward sign via the centroid test `loweredBoundary` uses), `reindexEdgeRefs` (retargets
  a piece's darts/curves/notches on node insert/delete, in lockstep with the seam loop — run before `commit()`),
  `migrateNotches`. One `setMode()` makes notch/sew/**curve**/**dart** mutually exclusive; `onDown` early-returns in
  any draw mode (a tap near a corner can't hijack a vertex drag). Fixed a latent **undo bug**: `restore()` did
  `body = o.body || state.body` → garment-toggle-OFF was un-undoable; now `body = o.body ? normalizeBody : null`.
  `clampSelection`/`setReadoutForSelection` handle `curve`/`dart`; legacy `{x,y}` notches eager-migrate on load.
- **Measurements card** (`#ed-measure`): doc-level `heightMm/bustMm/waistMm/hipMm` + a "Garment?" toggle
  (`state.body` ⇄ `DEFAULT_BODY`/null), display units, immediate write + debounced `commit()`. Lofts the dress form
  on `/preview`.
- **Curve drag-handle** (`#ed-curve`): tap a straight edge → `edges[i]={curve:{type:"quad",cp:[0.5, 0.15·inwardSign]}}`
  (bows **inward** — verified 3 ways; the design agent's `-0.15` was a winding misread); drag the blue dot
  (`worldToEdgeLocal`, `|v|≤1` clamp so a fat-finger drag can't explode the sheet count); numeric card =
  depth / Inward-Outward / shape **quad→cubic→arc** (the cycle **resizes `cp` 2↔4** or `cloneEdges` silently drops a
  malformed cubic) / delete.
- **Dart placement** (`#ed-dart`): tap an edge → wedge dart; drag the pink apex (**depth-only**, `dartApexLocal`
  shares `loweredBoundary`'s inward-normal so the handle sits on the printed tip; clamps to `[1, 0.45·L]`); card =
  width / depth / position / wedge-slash; deleting the last drops the `darts` key (byte-clean).
- **Notch types:** `handleNotchTap` writes upgraded `{edge,t,type}` (`t` from `ne.proj.t`) and a tap **cycles
  single→double→remove**; `drawPaths`/`hitNotch` switched to `notchTicks` + the analytic t-point (centered double).
- **Variable SA:** per-vertex `#ed-sa` field → `node.saMm` (0 drops it), a teal node highlight, and an honest
  "saved but inactive while this piece has curved edges" warning (the lowering ignores per-node SA when curves
  exist — `hasVarSA && !hasCurves`; a real geometry project, deferred).
- **⚠️ THE BUG THAT BLANKED CURVED GARMENTS (fixed):** the vendored `browser.maker.js` ships **without bezier-js**
  and expects a global `Bezier` script tag that was never added, so constructing any `BezierCurve` threw "Bezier
  library not found" → `drawPaths` blanked the canvas. Headless tests use **npm `makerjs`** (bundles bezier-js) so
  they couldn't catch it — only the bodice/dress (curves) broke; skirt/bags (no curves) were fine, so it looked
  garment-specific. **Latent pre-existing gap** (curved pieces had only ever flattened in Node) the curve UI would
  also have hit. Fix: vendored `app/static/js/vendor/bezier.js` (bezier-js 2.6.1, the version Maker 0.10.3 wants),
  loaded **before** `browser.maker.js` in `edit.html`; plus `pieceGeom` now **degrades to straight edges if a curve
  build throws** (a missing lib can never blank the editor again). New `tools/tiling/verify-vendored-maker.mjs` (7)
  loads the **real browser Maker stack** (npm tests can't) and asserts curves flatten + the degrade-never-blank
  fallback. Verified all 5 examples render through the vendored stack.
- Tests: `verify-editor-geom.mjs` 85→**113** (edge-local inverse round-trip + sign-pin, `reindexEdgeRefs`, cubic cp
  contract, dart floors/slash, notch-t/migration, SA caveat, body passthrough) + new `verify-vendored-maker.mjs`
  (7); print-spine sentinels (`verify-browser-gen`, bag `verify-cloth`) byte-identical green; full preview suite
  green. **Still deferred:** sew-mode refinements (match-notches/ease/gather); the node-delete edge-merge distortion;
  per-frame curve/dart-drag re-flatten perf (throttle if it lags); revisiting the waist dart on a fitted body.

**ATELIER VISUAL OVERHAUL DONE (2026-06-22, owner-gated — "very impressive work").** The app now carries its own
**atelier "cutting-table" identity** instead of the generic house shell, tuned for the owner's **1920×1080 touchscreen
laptop** with **large, glasses-friendly text** — the long-deferred "atelier re-skin + widescreen" workstream (DESIGN.md
"Visual identity" + the [[sewing-atelier-theme]] memory). **Presentation-only** — the print/geometry spine is
BYTE-IDENTICAL (`git diff` over `pattern-pdf.js`/`printing.py`/`pattern-geom.js`/fold/cloth/mesh/`preview3d.js`/
`main.py`/`models.py`/`db.py` is empty; full headless suite green), so the 1:1 tiler, calibration gate, IPP path + SSRF
guard are untouched; no DB/schema change.
- **Tokens (`styles.css`):** "two rooms, one palette" — warm **light cutting-table** working surfaces (paper `#efe9dd`,
  tissue cards `#fbf8f1`, warm ink `#21201c`, antique-brass accent **`#9a7430`** replacing the "aggressive" `#e0653a`,
  leather `#8a5a36`) for Home/Editor/Settings; the dark **studio showroom** stays scoped to `.pv` in `preview.html`
  (its bright brass `#c8a86b` is the dark-room oxidation — never used on light). The atelier values are the source of
  truth and the legacy house token names are aliased to them, so every existing component rule re-skins by value.
  **Always warm light** (the `prefers-color-scheme: dark` override was removed + `color-scheme: light`) — the showroom
  is the only dark surface. A guard (`.pv input,.pv select {min-height:0}`) keeps the 56px touch sizing from inflating
  the preview's compact floating controls.
- **Type:** 18px root + a large-first scale; vendored **IBM Plex Mono** (`app/static/fonts/ibm-plex-mono.woff2`,
  `@font-face` in `styles.css`, `--font-mono`) for measurements/dimensions (a "caliper readout"; degrades to the system
  monospace stack if the woff2 is absent). 56px buttons/inputs.
- **Shell (`base.html`):** a desktop **top nav** (Home · Draw · Settings, reuses `active_tab`) shown at `≥900px` where
  the phone `.tabbar` is hidden; below 900px the bottom tab bar stays. The house-hub pill is relabelled **"Hub"** (was a
  second "Home"). `theme-color`/`color-scheme` updated.
- **Home (`index.html`) = the "cutting-table dashboard"** (full-width `clamp` column): a "Your cutting table" hero with
  the printer status as a corner **"Press" plate** (single-line address, ellipsis + `title`), the **signature brass
  measuring-tape rule** (pure CSS), three large **create tiles** (Draw / Boxy tote / Rectangle — the two builders are
  `<details>` that expand in place; all `tote-*`/`rect-*`/`*-unit` ids + `data-action`s preserved so `app.js` is
  unchanged), and saved patterns as a **tissue-card gallery** on a recessed mat — each card shows a **real mini SVG
  drawing of its actual cut lines** via new **`app/static/js/pattern-thumb.js`** (lazy `IntersectionObserver` fetch of
  `GET /patterns/{id}`, draws the already-flattened `paths`; rebuilds authoring-only freeform docs via
  `PatternGeom.freeformToDoc`, box/rect via `PatternPDF`). **Home loads only `pattern-geom.js` + `pattern-thumb.js` —
  NO Maker.js, NO three.js** (verified). Inviting empty state; atelier microcopy.
- **Editor (`edit.html` + small ADDITIVE `editor.js`):** the crammed toolbar is now a segmented **Select / Notch / Sew /
  Curve / Dart** tool switcher (active = brass fill) + grouped history/util + a live **mode-hint bar**; `editor.js` gains
  `updateSelectChip`/`updateModeHint` + an `ed-select`→`setMode(null)` case (UI only — geometry untouched, `#ed-*` ids +
  `data-action`s preserved). Two-column workspace moved 860→**1024px**, rail widens 360→400→440 at 1440/1760, `dvh`
  height, distinct `#ed-numeric` (brass edge), sticky actions. Canvas stays the light `#fdfdfb` paper.
- **Settings (`settings.html`):** re-skinned to match (section heads w/ brass underline, two plates side-by-side ≥900px);
  `#printer-uri`/`#printer-info` + `save-printer`/`test-printer` preserved.
**Still deferred (visual):** the owner-only-eyeball items (no headless render test) — pattern-tissue thumbnails + the
widescreen feel were owner-confirmed; an optional warm "atelier night" dark mode; folding `.pv` into `styles.css`.
