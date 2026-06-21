# Handoff — the assembled 3D preview (build it)

> **For the next session.** Start in `~/sewingapp/`. Read, in order: `CLAUDE.md` (app
> guide), `DESIGN.md` (architecture + locked decisions), `PRINTING.md` (the sacred
> print spine), then **`PREVIEW.md`** — the **full build spec** this handoff drives.
> This doc is the *starting orders*: what's decided, what to build first, and the traps
> to avoid. The app is live at `command.home.arpa/sewing/` (container `sewingapp`, port
> 8006). **Nothing in PREVIEW.md is built yet — this session starts at M0.**

## The one-paragraph goal
Add an in-browser **3D preview of the sewn-up product**: tap "Preview" on a pattern,
see it assembled, orbit it. The real destination is a soft-body **garment cloth-drape**
(she's making skirts + tank-style dresses) — *not* just bags. You do **not** start by
writing a cloth solver. You build the **seam graph** first (the data that says "edge X
of piece A is sewn to edge Y of piece B"), because the cheap rigid bag fold-up *and* the
expensive garment drape are both driven by that one graph. Steps 1→2 are the deliberate
on-ramp that builds and proves the foundation Step 3 needs. Full rationale + field specs
+ algorithms are in `PREVIEW.md`; **read it before writing code.**

## Locked decisions (don't relitigate)
- **The bright line.** Structured things (bags) are **constructed** geometrically
  (cheap, deterministic, headless-testable). Draped things (garments) are **simulated**
  (expensive, eyeball-verified). `PREVIEW.md §1`.
- **Garment scope = sleeveless-first** (skirts, tank-style dresses). Sleeves/collars are
  an **additive M6 escape hatch** (a body-collider swap) — building sleeveless-first
  throws away nothing: the seam graph, triangulation, XPBD solver, stitching, fabric
  presets, and the whole schema-3 data model carry forward; only the body collider gains
  arms. `PREVIEW.md §10 Q1–Q2 (resolved 2026-06-21)`.
- **Keystone = a top-level `seams[]` graph**, schema 2→3, **additive, no DB migration**
  (`params_json` is opaque server-side text). `PREVIEW.md §3`.
- **Architecture inherited, non-negotiable:** browser-side geometry; **no build step**
  (three.js via native import map; hand-rolled **pure-JS XPBD** solver — deliberately
  does NOT trip DESIGN.md's FreeSewing build-step trigger); the server stays a dumb
  store + IPP relay; the **print spine + calibration gate are untouched** (the preview
  is read-only of the doc and never calls a print endpoint). `PREVIEW.md §2.1, §2.4`.
- **Lives on a separate `/preview/{id}` page** with a **separable** Step-3 module set —
  not a tab inside `/edit`, not a separate service, not server-side 3D. `PREVIEW.md §2.4`.
- **Solver choice settled:** hand-rolled XPBD mass-spring (`pattern-cloth.js`), **not**
  ammo.js (stale/heavy WASM) or Rapier (no cloth). `poly2tri` (BSD-3) for triangulation.
  `PREVIEW.md §6.1`.
- **Body = a procedural lofted "dress form"** (~200 lines + a tiny profile table) sized
  from bust/waist/hip with **analytic ellipse collision** — no SMPL, no mesh/SDF.
  `PREVIEW.md §6.7`.

## The architecture you inherit (so you don't relearn it)
- **The print path is sacred and DONE.** The preview only *reads* the pattern document;
  it never feeds the printer. **Never touch** `app/static/js/pattern-pdf.js` (the
  tiler + its self-assertions), `app/printing.py`, the calibration gate, the print
  lock, or the SSRF guard. Run `tools/tiling/verify-browser-gen.mjs` if you so much as
  breathe near `pattern-pdf.js`.
- **The shared document** the tiler reads: `{ name, kind, widthMm, heightMm,
  paths:[{kind:"cut"|"fold"|"seam"|"grain", points:[[x,y]…]}], labels:[…], params }`.
  Coords are **mm, bottom-left origin, y-up**. The tiler draws only straight-segment
  polylines — **all curves are flattened before they enter `paths`.**
- **Freeform doc = `params.pieces[]`** (schema 2). Each piece: `{id,name,count,seamMm,
  cornerRadius,closed, nodes:[{x,y,radius}], notches:[{x,y}], placements:[{x,y,w,h,
  label}], layout:{x,y}}`. **Node coords are LOCAL to the piece; board coord = local +
  `layout`.** Schema 3 *adds* a top-level `seams[]` + per-piece `edges`/`darts`,
  upgraded `notches:{edge,t,type}`, optional `place3d`, and a doc-level `body` +
  `preview3d` cache — **all optional, all additive** (`PREVIEW.md §3.3`). Bump
  `schema:3` only when a schema-3 field is actually present.
- **Edge identity (the rule copied into every new field):** a seam/dart/notch references
  an **authored node-edge** — `edge i = "the boundary edge leaving node i"` (segment
  `node[i]→node[i+1]`, mod the closed loop) — **never** a flattened-segment index, never
  raw coords. This is the exact convention `insertVertexOnEdge`/`nearestEdge` already use
  in `pattern-geom.js`. A point on an edge is an arc-length fraction `t∈[0,1]`.
  `PREVIEW.md §3.2`.
- **`G.pieceGeom(piece)` is the single source of truth** for the flattened `{cut, seam}`
  outlines — shared by print (`freeformToDoc`) and preview. It needs Maker.js to flatten
  fillets/curves/seam, so **the preview page loads the classic geom stack too** (see the
  load pattern below). Without Maker.js it silently degrades to straight lines.
- **Asset versioning is automatic.** `_compute_asset_ver()` (`app/main.py:45`) hashes
  every `.js`/`.css` under `static/`; dropping vendored files auto-rolls `ASSET_VER`, so
  `?v={{ asset_ver }}` on each URL busts stale iPad caches with zero code change.

## Spec reconciliations (decided — so you don't trip on them)
1. **`preview.js` vs `preview3d.js`.** `preview.js` is the thin **`type="module"` entry**
   the template loads; it imports the scene/render logic from sibling modules
   (`preview3d.js` = three.js scene/renderer; later `pattern-fold.js`, `pattern-mesh.js`,
   `pattern-cloth.js`, `body-form.js`). One entry, several modules. No conflict.
2. **Maker.js on the preview page = YES.** `PREVIEW.md §2.3` is now fixed to load
   browser.maker.js → maker-shim → pattern-geom (classic `defer`) **before** the import
   map + `preview.js` module, exactly like `/edit`. The ESM module reads the classic
   `window.PatternGeom`/`window.makerjs` globals fine (the import map only rewrites bare
   specifiers inside `type="module"` scripts).

## START HERE — M0: the loader spike (the one gate that de-risks everything)
**Goal:** prove the no-build three.js import-map path renders + touch-orbits on her
actual iPad. Hardcoded cube, zero pattern geometry, zero physics.

1. **Vendor three.js r184** (verify the current minor at build time; MIT). Copy
   `build/three.module.js` → `app/static/js/vendor/three/three.module.js` and
   `examples/jsm/controls/OrbitControls.js` →
   `app/static/js/vendor/three/addons/controls/OrbitControls.js`. **Same release tag for
   core + every addon** (mixing versions throws at runtime). Add
   `app/static/js/vendor/three/README` pinning the version + "update as a matched set."
2. **Route:** add `GET /preview/{id}` to `app/main.py` (render `preview.html` with the
   pattern doc; 404 if missing) — mirror the existing `/edit/{pid}` route. No persistence
   change.
3. **Template:** new `app/templates/preview.html extends base.html`, fills `head_extra`
   with (in this order): the classic geom stack (`browser.maker.js` → `maker-shim.js` →
   `pattern-geom.js`, `defer`); `window.SEWING_PREVIEW = {{ (pattern or {})|tojson }}`;
   the **inline** `<script type="importmap">` (`"three"` → the vendored module URL with
   `?v={{ asset_ver }}`, `"three/addons/"` → the addons dir); then
   `<script type="module" src="{{ base_path }}/static/js/preview.js?v={{ asset_ver }}">`.
   Exact snippet in `PREVIEW.md §2.2`. The import map must come **before** the module.
4. **Module:** `app/static/js/preview.js` (`import * as THREE from 'three'` +
   `OrbitControls`), set up Scene/PerspectiveCamera/WebGLRenderer/HemisphereLight, render
   a cube, attach OrbitControls.
5. **Nav:** a "Preview" affordance — at minimum a "Preview →" button on `/edit` and a
   link from a saved pattern. (Full tab-bar entry can wait for M1.)

**M0 gate (the real stop point):** on her iPad, `/sewing/preview/<id>` shows a cube you
can pinch-zoom + orbit; no console errors; Home/Draw/print flows unaffected; `ASSET_VER`
busts the vendored three.js on deploy. **If the import map or touch orbit fails on the
iPad, fix delivery before anything else** — every later milestone rides on it.

## Then M1 — box preview (still zero physics)
`docToMesh(doc)` for `kind:"box"`/a boxy tote: read panel dims, place 5 quads + 2 strap
ribbons into a box; **texture each face** by rendering that piece's flattened `cut`
outline (+ seam/label) to a `CanvasTexture`. This canvas-to-texture step is reused
verbatim by Steps 2–3. Test: `tools/preview/verify-box-mesh.mjs` (6 faces, correct dims,
closed bbox). **Gate:** a real saved tote previews as a correctly-proportioned,
pattern-textured 3D box on the iPad. `PREVIEW.md §4`.

## The milestone ladder (detail in `PREVIEW.md §9`)
- [x] **M0** — loader spike (cube on iPad). *DONE — built + iPad gate cleared 2026-06-21
      (orbitable cube via no-build three.js r184 import map; `/preview/{id}` page; print
      spine untouched).*
- [x] **M1** — Step 1 box preview (`docToMesh` + face texturing). *DONE 2026-06-21 — boxy
      tote previews as a proportioned, pattern-textured box; flat leather straps (arc-len =
      strap length); studio/atelier look + "finished measurements" spec plate; inches/cm
      units; `tools/preview/verify-box-mesh.mjs` (18 checks).*
- [ ] **M2** — seam graph + **Sew mode** (schema-3 `seams[]`, edge identity, cross-piece
      edge-pair selection UX on `/edit`, dart self-seam emission). *~3–5.*
- [ ] **M3** — Step 2 rigid fold-up (`pattern-fold.js`: spanning tree + Levenberg–
      Marquardt closure solve for the cyclic seams; three.js hinge renderer; graceful
      degradation). *~3–5.* **← M3 must be solid before M4/M5: the rigid fold is the warm
      start that keeps the cloth solver from exploding.**
- [ ] **M4** — Step 3a inflated bag (`pattern-mesh.js` poly2tri triangulation;
      `pattern-cloth.js` XPBD distance/bend/seam/pressure; the §6.6 stability protocol;
      `preview3d` settled cache). *~6–10.*
- [ ] **M5** — Step 3b garment on a form (`body-form.js` lofted dress form + analytic
      ellipse collider from `body` measurements; gravity drape; pinning + timed release;
      spatial-hash self-collision; fabric presets; curves/ease/darts in the drape). The
      most uncertain stretch — the hard patches live here. *~10–20.*
- [ ] **M6 (deferred)** — sleeves/collars (CC0 MPFB body + collider swap) and/or WebGPU
      (TSL) compute acceleration — only when a real sleeved attempt or a perf ceiling
      shows up.

## Files (create / touch)
**New (all browser-side, all in `app/static/js/` unless noted):**
| Path | What | Milestone |
|---|---|---|
| `vendor/three/three.module.js` + `addons/controls/OrbitControls.js` | vendored three.js r184 (matched set) | M0 |
| `app/templates/preview.html` | the preview page (extends base.html) | M0 |
| `preview.js` | ESM page entry (imports three + the modules below) | M0 |
| `preview3d.js` | three.js scene/renderer; `docToMesh`; box mesh + face texturing | M0–M1 |
| `pattern-fold.js` | **pure/headless** hinge graph, spanning tree, forward fold, LM closure solve (no three.js; returns per-piece transforms) | M3 |
| `pattern-mesh.js` | **pure/headless** triangulation (poly2tri + Steiner points); lift `pointInPoly` here out of `editor.js` | M4 |
| `pattern-cloth.js` | **pure/headless** XPBD solver (distance/bend/seam/pressure/pin) | M4 |
| `body-form.js` | **pure/headless** lofted dress form + analytic ellipse collider | M5 |
| `vendor/poly2tri.js` | vendored triangulator (BSD-3) | M4 |
| `tools/preview/verify-*.mjs` | headless harnesses (box-mesh, fold, mesh, seam-correspondence, body-form) | per step |

**Touch (additively):** `app/main.py` (`/preview/{id}` route; later schema-3 normalize in
the pattern read path is browser-side, so likely none server-side); `app/templates/
base.html` (a "Preview" tab) + `index.html`/`app.js` (link to preview from a saved
pattern); `app/static/js/pattern-geom.js` (schema-3 `seams[]` normalization, dart
self-seam emission, lifting `pointInPoly`); `app/static/js/editor.js` (Sew mode UX).
Keep `pattern-fold/mesh/cloth/body-form.js` **DOM-free** so the `.mjs` tests can eval them.

## How to work / verify
```bash
# headless geometry tests (run from tools/preview — keep its own package.json/node_modules,
# pin three@0.184 + poly2tri there to match the vendored bundle, like tools/tiling does):
cd ~/sewingapp/tools/preview && node verify-box-mesh.mjs   # then verify-fold.mjs, etc.
# print-spine regression — run after ANY pattern-pdf.js / pattern-geom.js touch:
cd ~/sewingapp/tools/tiling && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code is baked into the image — rebuild after edits):
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- **No root needed** (high port, rootless, all `systemctl --user`).
- **Can't run `sudo`** here — if a root step ever comes up, hand the user exact commands
  for their root SSH session.
- **Auto-testable** (do it): schema-3 normalize + back-compat; edge-identity stability;
  fold closure→0 + degradation; triangulation node-count/inside/no-dupes; seam
  arc-length correspondence; body-form ring circumferences; cache round-trip.
  `PREVIEW.md §7`.
- **Hand-verified only** (no honest oracle): Sew-mode drag/tap UX on the iPad; the drape
  *look*; stitch-up **stability** on her real saved patterns (keep a small corpus as
  visual regression fixtures). `PREVIEW.md §7`.

## Don't-break checklist
- `makeTiledPdf` keeps passing its self-assertions (612×792, no rotation,
  CropBox==MediaBox, ink in the ≥13 mm keep-out). Calibration-first gate, SSRF guard,
  print lock all intact. The preview never calls a print endpoint.
- New features **lower to existing line-kinds** (`cut`/`seam`/`fold`) before
  `freeformToDoc` builds `paths` — so `pattern-pdf.js`/`printing.py`/the tiler/the gate
  never learn about `seams`/`curve`/`darts`/`gather`/`preview3d`.
- **Schema back-compat:** schema-1 (single `nodes`) and schema-2 (pieces, no seams) docs
  must keep loading unchanged; `pieceGeom` keeps its no-Maker.js straight-line fallback.
- **Degrade, never hard-fail:** Step 2 falls back to a tree-only fold; Step 3 falls back
  to Step 2's rigid fold if the drape won't settle. No blank screen.
- BASE_PATH on every emitted URL and `fetch()`. Maker.js + three.js load **only** on
  `/edit` (Maker.js) and `/preview` (both) — Home stays lean.

---
## New asks for this session
> _(owner: add anything you want adjusted before/while building — e.g. "start M0 now",
> a different first garment than a skirt, or a tweak to the data model.)_
