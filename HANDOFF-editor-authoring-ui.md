# Handoff — the interactive garment-authoring UI (`/edit`)

> **For the next session.** Start in `~/sewingapp/`. Read, in order: `CLAUDE.md` (app guide + the
> M5a/M5b/M5c status at the end), `DESIGN.md`, `PREVIEW.md` (esp. **§3.2 edge identity** + **§3.3 the
> field spec**), then this file. App is live at `command.home.arpa/sewing/` (container `sewingapp`,
> port 8006). HEAD = `5fb5a8a` on `main` (remote `EWH2000/sewingapp`).

## The goal
Let the owner **DRAW** garments on `/edit` — curves (necklines/armholes/A-line), darts, notch
type, body measurements — instead of only getting them from `tools/seed-examples.mjs`. This is
**purely additive UI** on `app/static/js/editor.js` + `app/templates/edit.html`. The **data model
+ print lowering are already DONE** (M5a): every feature already lives in `pattern-geom.js` and
lowers to `cut`/`seam` lines before the print spine. This work just adds the touchscreen tools to
read/write that model — no schema change, no solver change, no print-spine change.

## The substrate you build on (don't relearn it)
- **Mode system** = a string state machine (`mode` ∈ `idle/drag/dragPlace/dragPiece/maybePiece/
  maybeSew/pan/pinch`, editor.js ~797) + boolean flags (`notchMode`, `sewMode`, `snapOn`). Pointer
  events route through `onDown/onMove/onUp` (~802–890); a stationary tap routes through
  `resolveActiveTap` (notch/edge-insert) or `handleSewTap`.
- **The node-drag is the template for every new handle** (~836): `S2W(screen) → snapWorld(grid) →
  boardToLocal → round2 → write to nodes[i] → scheduleRender()`, then `commit()` on `onUp` if moved.
  Copy this shape for the curve handle and the dart handle.
- **Transforms**: `W2S`/`S2W` (editor.js 149–150 → `PatternGeom.worldToScreen/screenToWorld`,
  y-flipped). Pieces are in LOCAL coords; `piece.layout {x,y}` is the board offset — always
  `boardToLocal()` a snapped board point before writing a node, and add the layout when rendering.
- **Hit-testing** is screen-space: `hitVertex` (22px), `hitEdge` (14px), `hitPlacement`, `hitNotch`,
  `hitPiece` (552–606). Add `hitCurve`/`hitDart` (~12px) the same way.
- **Render**: `scheduleRender()` (RAF-batched) → `render()` → `drawPaths` (geometry, #paths) +
  `drawOverlay` (labels + #handles + seam connectors). Add curve/dart handles in `drawOverlay`.
- **Persistence is one path**: `commit()` snapshots `{pieces,seams,body,active,name}`; `restore()`
  rehydrates through `normalizePieces/normalizeSeams/normalizeBody`, so **anything `clonePiece`
  carries survives undo automatically** — and `clonePiece` (pattern-geom.js 172–212) already carries
  `edges`, `darts`, `notches`, per-node `saMm`, `placements`, `role`. **This is the critical sync
  point: never add a per-piece field the editor writes but `clonePiece` doesn't carry.**
- **Save/print** = `buildDoc()` → `G.freeformToDoc()`; curves/darts/notches/SA already serialize +
  lower. `hasSchema3` bumps the doc to schema 3 only when a schema-3 field is present (schema-2 docs
  stay byte-clean for the tiler).

## The data model (already exists — read/write it, don't invent)
- **Curves**: sparse `piece.edges = { "<edgeIndex>": { curve: { type:"quad"|"cubic"|"arc", cp:[…] } } }`.
  `cp` is in the **edge-local frame** `[u,v]` (quad/arc: 2 values; cubic: 4). `u∈[0,1]` along the
  chord, `v` scaled by chord length (scale/pack-invariant). Flattened by `modelFromNodes` via
  Maker.js `BezierCurve` (pattern-geom.js 285–302) — the SAME flatten print + drape share.
- **Darts**: `piece.darts = [{ id, edge, center, width, depth, kind:"wedge"|"slash" }]`. `center∈[0,1]`
  along the edge, `width`/`depth` in mm. `loweredBoundary` (309–355) splits the wedge + drops an apex
  **without mutating `piece.nodes`** — darts live in `darts[]` only, NEVER derived into `seams[]` (the
  solver's `selfSeamPairs` pairs the legs; see the `sewing-m5a-dart-representation` memory).
- **Notches**: upgraded `{edge,t,type:"single"|"double"}` (`t` = arc-length fraction); legacy `{x,y}`
  migrates on save (`migrateNotches`). Notch mode currently writes the **legacy** shape — the upgrade
  is part of this work.
- **Variable SA**: per-node `node.saMm`. **Caveat (pattern-geom.js ~437): variable SA is ignored when
  the piece also has curves** (`hasVarSA && !hasCurves`) — note it in the UI or fix the lowering.
- **Body**: doc-level `state.body = { heightMm, bustMm, waistMm, hipMm }` or `null` (bags). Defaults
  `1650/920/740/980`. Lofts the dress form on `/preview`; the flat editor doesn't change visually.

## ⚠️ Do this FIRST — the cache bug that hides curves/darts
`pieceGeomCached` (editor.js 235–243) keys the geometry cache on
`JSON.stringify({n:p.nodes, r:cornerRadius, s:seamMm, c:closed})` — it **omits `p.edges` and
`p.darts`**, so adding/editing a curve or dart leaves a stale cache and **nothing renders**. Fix the
key before building any curve/dart UI:
```js
const key = JSON.stringify({ n: p.nodes, r: p.cornerRadius || 0, s: p.seamMm || 0, c: p.closed,
                             e: p.edges || null, d: p.darts || null });
```
(Per-node `saMm` is already covered because it lives inside `p.nodes`.)

## Build order (MVP-first; each chunk is independently shippable + owner-gated)

### 1. Measurements card (easiest, unblocks hand-drawn garment preview)
Mirror `/preview`'s `#pv-measure` (preview.js ~287–309) on `/edit`: a doc-level card (above the
piece list, NOT per-piece) with `heightMm/bustMm/waistMm/hipMm` inputs bound to `state.body`,
shown in display units (`state.unit` in/cm; model stays mm). On change → `commit()` (debounce
~400ms so a run of keystrokes doesn't thrash). A "garment?" toggle sets `state.body` to the defaults
vs `null`. Without this a hand-drawn piece has no form to drape on.

### 2. Curve drag-handle (the core, the trickiest)
A `Curve` toolbar toggle (`#ed-curve`, mirror `#ed-seam` wiring). In curve mode:
- Tap a straight edge → create `piece.edges[i] = { curve:{ type:"quad", cp:[0.5, 0.15] } }` (a gentle
  default bow) and select it (`selection.type="curve"`).
- Render a draggable control dot in `drawOverlay`: forward transform `G.edgeLocalToWorld(a,b,u,v)`
  (already exists, pattern-geom.js 277–281) → `+layout` → `W2S` → an `~7px` circle.
- Drag → invert screen→edge-local and write `cp`. **Add the inverse helper** (not yet in
  pattern-geom.js — export `G.worldToEdgeLocal`), exact inverse of `edgeLocalToWorld`:
  ```js
  function worldToEdgeLocal(a, b, P) {            // P, a, b in the SAME (local) frame
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx*dx + dy*dy || 1;
    const px = P.x - a.x, py = P.y - a.y;
    return [ (px*dx + py*dy) / L2,                // u  = (P−a)·d / |d|²
             (-px*dy + py*dx) / L2 ];             // v  = (P−a)·n̂ / |d|   (n̂ = (−dy,dx)/|d|)
  }
  ```
  So `onMove`: `const w = boardToLocal(S2W(p)); cp = worldToEdgeLocal(a, b, w); piece.edges[i].curve.cp = [round2(u), round2(v)]`. `commit()` on `onUp`.
- **Sign convention**: positive `v` bows toward the left-normal `n̂=(−dy,dx)/L`; for the seeded
  necklines/armholes positive `v` bows **inward**. Validate against a seeded piece (id 6/7) before
  trusting the sign.
- Numeric card (`updateNumericPanel`, `selection.type==="curve"`): show `u`/`v` (or a depth slider) +
  a type cycle (quad→cubic→arc) + **Delete** (remove `piece.edges[i]`). `cubic` adds a second handle
  (`cp[2],cp[3]`).

### 3. Dart placement
A `Dart` toolbar toggle. Tap an edge in dart mode → `piece.darts.push({ id:"d"+n, edge, center:0.5,
width:26, depth:120, kind:"wedge" })` + select it. Render a depth handle (apex = edge-midpoint +
`depth`·inward-normal) you can drag (updates `depth`); the numeric card sets `center/width/depth` +
a `wedge/slash` toggle. `loweredBoundary` redraws the wedge automatically (don't call it yourself —
it's read-only + expensive; just mutate `piece.darts` and re-render).

### 4. Notch type upgrade
Extend `handleNotchTap` (599–620) to store the **upgraded** `{edge, t, type:"single"}` (compute `t`
from the `nearestEdge` projection it already does) instead of legacy `{x,y}`; tap a tick → cycle
`single→double→remove`. `notchTicks` (pattern-geom.js 475–488) already renders both.

### 5. Variable seam allowance (per-node)
When a vertex is selected, add an "SA at this corner (mm)" field in `updateNumericPanel` → `node.saMm`;
highlight nodes with `saMm>0`. (Mind the curves-vs-SA caveat above.)

### 6. Sew-mode refinements (lowest priority)
"Match notches" (seed `seam.anchors:[{ta,tb}]` from matching notch `t` on both edges), an ease/gather
card, and a flip-direction toggle (the existing `setSeamFlip` already cycles auto→fwd→flip).

## Gotchas (the ones that will bite)
- **Edge identity is by index, and indices shift.** Edge `i` = node `i`→node `i+1` (the AUTHORED
  segment). Inserting/deleting a node renumbers downstream edges: `reindexSeamsForInsert/Delete`
  already retargets seams — **darts (`.edge` int) and curves (string key) need the same retarget** or
  a warn. Test: add a node upstream of a curved edge; the curve must stay on its authored edge.
- **`clonePiece` + `restore` are the only persistence.** A field the UI writes but `clonePiece`
  doesn't carry is silently lost on undo. (Curves/darts/notches/saMm already carry — keep it that way.)
- **Print spine is sacred.** Everything lowers in `pieceGeom`/`pieceExtras` BEFORE `freeformToDoc`;
  `pattern-pdf.js`/`printing.py`/the calibration gate never see the new fields. Run the tiling tests
  after ANY `pattern-geom.js`/`editor.js` edit.
- **Maker.js is only loaded on `/edit`** (`maker-shim.js` before `pattern-geom.js`); `pieceGeom`
  degrades to straight edges if absent. The server has its own Maker import for the PDF.
- **Modes are mutually exclusive** — toggling Curve/Dart should turn off Notch/Sew (and vice-versa).
- **`#ed-*` panels are re-rendered by `innerHTML`** every frame — re-wire listeners each render (the
  existing code does this; keep no detached DOM refs).

## How to work / verify / deploy
```bash
# headless suite (all green at HEAD; extend, don't break)
cd ~/sewingapp/tools/preview && for t in verify-mesh verify-seam-correspondence verify-cloth \
  verify-cloth-mesh verify-fold verify-fold-mesh verify-box-mesh verify-lowering verify-body-form \
  verify-garment-drape; do node $t.mjs; done
cd ~/sewingapp/tools/tiling && node verify-seams.mjs && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code baked into the image — rebuild after edits)
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- **`verify-editor-geom.mjs` + `verify-browser-gen.mjs` (print spine) + `verify-cloth.mjs` (bag) are
  the regression sentinels** — keep them byte-identical green.
- **The UI itself has no automated oracle** — the owner gates it hands-on on her **touchscreen laptop
  (Fedora KDE — NOT an iPad)**. Rhythm: build → deploy → she draws a curve/dart/measurement → "looks
  good" → update `CLAUDE.md` Status + `PREVIEW.md` §9 → **commit + push directly to `main`** (no PRs).
- New deterministic geometry (the `worldToEdgeLocal` inverse, notch-`t` computation, dart placement
  → lowering) SHOULD get headless assertions in `tools/tiling/verify-editor-geom.mjs` (e.g.
  forward∘inverse round-trips to identity; a placed dart lowers to a valid 1:1 print doc).

## Deferred (track, don't lose)
The waist dart may be redundant on a fitted body (the form now provides the bust shape — revisit);
plain-leather strap texture; the residual ~3–4 mm "warm" drape jitter; per-corner radius; overlap
warnings. M6 (sleeves/collars via CC0 MPFB body, WebGPU/TSL) stays deferred.
