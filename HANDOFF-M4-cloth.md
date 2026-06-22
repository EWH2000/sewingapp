# Handoff — M4 / Step 3a: sew the panels into an inflated 3D bag (XPBD cloth)

> **✅ DONE 2026-06-21 — owner gate cleared on her touchscreen laptop.** Built `pattern-cloth.js`
> (XPBD solver), `preview3d.drapeToGroup` (pattern-textured render), the `/preview` Fold⇄Inflated
> toggle + detail control + "Settling…" badge + settled cache, with tests `verify-cloth.mjs` (26) +
> `verify-cloth-mesh.mjs` (16). Two changes vs the orders below: **(1)** inflation uses a **per-node
> tether** (≤5% of the bag diagonal) on top of per-face pressure — §6.4's "stretch balances pressure"
> turned out to be a knife-edge buckling threshold on a free-top bag, so the tether is what makes it
> round-not-balloon robustly; **(2)** v1 does **not** weld (stiff zero-rest seam springs instead), to
> keep one piece per node for clean texturing. **Follow-up — strap snap-to-surface — DONE 2026-06-22**
> (the drape view snaps each handle anchor to the nearest settled node, so handles attach flush to the
> puffed bag, not the folded rim). The live status is in `CLAUDE.md` + `PREVIEW.md §9` +
> `HANDOFF-3d-preview.md`. The starting orders below are kept for the record.

> **For the next session.** Start in `~/sewingapp/`. Read, in order: `CLAUDE.md` (app guide +
> live status), `DESIGN.md` (architecture + locked decisions), `PRINTING.md` (the sacred print
> spine — never touched here), `PREVIEW.md` (the 3D-preview build spec — **read all of §6 Step 3,
> especially §6.1 solver choice, §6.2 triangulation, §6.3 seams, §6.4 inflation, §6.6 the
> stability protocol, and §3.4 the settled-drape cache**), then this file. The app is live at
> `command.home.arpa/sewing/` (container `sewingapp`, port 8006). **HEAD = `b2d8305` on `main`**
> (remote `EWH2000/sewingapp`). M0–M3 + strap handles are DONE; the **M4 prep layer is DONE**
> (this handoff is the rest of M4).

## The one-paragraph goal
The rigid fold (M3) shows a bag's panels *folded up* but flat/creased. M4 = **Step 3a (inflated
bag)**: sew the flat panels together with a hand-rolled **XPBD mass-spring solver**
(`app/static/js/pattern-cloth.js`) and **inflate** them into a soft, rounded 3D bag — gravity off,
no body, no self-collision (those are M5). The rigid fold is the **warm start** (this is why M3
exists): place each piece's sim mesh at its folded `{pos,quat}` so seam endpoints begin *close*,
then run the §6.6 stability protocol (zero-gravity stitch-up with eased seam stiffness, tiny
substeps + velocity clamp), weld the seams, inflate, settle, **cache the settled mesh**. Render the
draped surface in `preview3d.js`; add a "Preview detail" control; the strap handles ride on top
unchanged. **This is the riskiest plumbing in the whole plan** (`~6–10 sessions` — the stitch-up
not exploding on real, slightly-inconsistent patterns is the make-or-break). Build it in tested
increments; the visible result is the owner's gate.

## Where we are — the M4 PREP LAYER is built, tested, committed (don't relearn it)
All pure/headless (no three.js), three commits back (`318a30a`, `45b452a`):

- **`app/static/js/vendor/poly2tri.js`** — vendored CDT (1.5.0, BSD-3; its UMD attaches
  `window.poly2tri`). Pinned in `tools/preview/package.json`. Load it on `/preview` (classic
  `<script>`, before `pattern-mesh.js`) when you wire the drape — **not loaded yet**.
- **`app/static/js/pattern-mesh.js`** (`window.PatternMesh`, pure, reads `window.poly2tri` +
  `window.PatternGeom`):
  - **`triangulatePiece(piece, h)`** → `{ nodes:[[x,y]…], boundary:[idx…],
    boundaryMeta:[{edge,t}…], tris:[[a,b,c]…], dist:[[i,j,rest]…], bend:[[i,j,rest]…] }` in
    **piece-local mm** (y-up, same frame as authored nodes). `h` = target node spacing.
    `dist` = unique triangle edges (stretch springs); `bend` = opposite-vertex pair across each
    interior shared edge (cheap dihedral approx). `boundaryMeta[k]` tags boundary node k with the
    **authored edge** it sits on and its arc-length **t∈[0,1)** — the hook for seam stitching.
    Degrades to a centroid fan if poly2tri is absent; never throws.
  - **`seamPairs(meshA, eA, meshB, eB, {flip})`** → `[[nodeA, nodeB]…]` node-index pairs across a
    seam by arc-length. **Direction matches the fold's convention** (head-to-tail `A0↔B1` default;
    head-to-head on `flip`), so adjacent pieces sew corner-to-corner; unequal-length edges gather.
  - Also exported: `edgeNodes`, `pointInPoly`, `resampleBoundary`, `interiorGrid`.
  - Tests: `tools/preview/verify-mesh.mjs` (15) + `verify-seam-correspondence.mjs` (16) — green.
- **The warm start: `app/static/js/pattern-fold.js`** `window.PatternFold.foldDoc(pieces, seams,
  opts)` → `{ mode, transforms:{<id>:{pos,quat}}, root, cycles, closures, straps, hinges,
  nonHingeable }`. `transforms[id]` places a piece's local `(x,y,0)` into the world via
  `world = pos + quat·(x,y,0)` (quat = `[x,y,z,w]`). **Strap pieces are EXCLUDED** from
  `transforms` and returned as `straps[]` arched-handle specs (M3 + strap session) — keep them out
  of the cloth sim and render them as today.

## What to build
**0. Thread (or derive) the per-seam sew DIRECTION.** `seamPairs` needs `flip` per seam. The fold
   already chooses it but only exposes it for tree seams (`hinges[].flip`), not closure seams.
   **Recommended: derive it in the cloth solver from the warm-start geometry** — after placing
   nodes by `transforms`, for each seam compare the two endpoint pairings and pick the nearer
   (mirror `inferFlip`/`closureGap` in `pattern-fold.js`). Decoupled + robust. (Alternative: add an
   additive `seamFlips:{<seamId>:bool}` to `foldDoc`'s return.)

**1. `app/static/js/pattern-cloth.js`** — pure/headless `window.PatternCloth` (a classic IIFE like
   `pattern-fold.js`; **NO three.js, NO DOM** — keep the headless eval-test trivial). Suggested API:
   `solveDrape(pieces, seams, opts) → { nodes:[[x,y,z]…], tris:[[a,b,c]…], pieceRanges:[{piece,start,count}], welds, mode, energy }`.
   - **Assemble (warm start, §6.6.A).** For each non-strap piece: `triangulatePiece(piece, h)`;
     lift its local nodes to 3D world via `foldDoc`'s `transforms[piece.id]`
     (`pos + quat·(x,y,0)`). Concatenate into one global 3D node array; remember each piece's node
     range and its boundary/boundaryMeta (offset by the range start).
   - **Constraints.** Distance (stretch) from each piece's `dist`; bending from `bend`; **seam
     springs** = `seamPairs(...)` per seam → zero-rest distance constraints between the two global
     node indices. Use XPBD `compliance` (per type) as the stiffness knob.
   - **Stability protocol (§6.6, IN ORDER — the make-or-break):**
     - **B. Zero-gravity stitch-up.** Gravity + pressure OFF. Structural + seam springs only; ease
       seam stiffness soft→stiff over ~30–60 substeps (ramp compliance). Panels float together.
     - **C. Small substeps + velocity clamp.** Many substeps, ~1 iteration each (8–20 during
       stitch-up); **clamp per-substep node move to ≈ 0.5·h** — the single most important explosion
       guard.
     - **D. Weld.** Seam pairs within tol (~1 mm) → weld each pair into one shared node (average
       position, sum mass, rewire triangles) to kill jitter + halve seam constraints. (v1 may skip
       welding and keep stiff zero-rest springs if simpler — note the tradeoff.)
     - **Inflate (§6.4, bags).** **Open-top caveat:** a tote is NOT a closed surface, so the
       divergence-theorem *enclosed-volume* constraint isn't well-defined. **Recommended: per-face
       outward-normal "puffiness" pressure** (each triangle pushes along its outward normal ∝ area),
       eased in after stitch-up, balanced by the stretch constraints → a gently rounded bag. No
       closed-surface requirement. (If you want true volume, virtually cap the opening with a fan
       to a rim centroid first.)
     - **E. Settle then freeze.** Run until kinetic energy < threshold; freeze + return the mesh.
   - **Determinism:** seed any randomness (or avoid it) so the headless test is reproducible.
   - **Perf:** target ~1–4k nodes whole-bag (`h` ≈ 15–25 mm), settle-once (a second or two), not a
     per-frame loop.

**2. `app/static/js/preview3d.js`** — a **drape view** (additive; leave `buildFoldedGroup`/the box
   path/`addStraps` intact). Build ONE `BufferGeometry` from the settled `nodes` (3D) + `tris`,
   `computeVertexNormals`, `MeshStandardMaterial` (`DoubleSide`). Texture by piece region using the
   existing `pieceFaceTexture(piece, unit)` (UV per `pieceRanges`) **or** a plain fabric material
   for v1. Re-draw the `straps[]` arched handles on top via the existing `addStraps`.

**3. `preview.js` + `app/templates/preview.html`** — load `poly2tri.js` + `pattern-mesh.js` +
   `pattern-cloth.js` on `/preview` (with `BASE_PATH`); add a **"Preview detail: Draft / Standard /
   Fine"** control (sets `h`) and a **fold ⇄ inflated** toggle (so she can still see the rigid M3
   fold). Show a brief **"Settling…"** indicator while solving. The drape replaces the fold as the
   default *shown* result for a freeform-with-seams bag; the fold stays available as the warm start
   + the toggle.

**4. Settled cache (§3.4).** Persist the settled mesh in the doc as an additive opaque field:
   `params.preview3d = { simVersion, geomHash, h, nodes, tris, pieceRanges, settledAt }`
   (`geomHash` = hash of pieces+seams+h). On open: if `simVersion` + `geomHash` match, load straight
   into the `BufferGeometry` (instant, zero sim); any edit invalidates → re-drape lazily. Save via
   the **existing** `POST /patterns` (server stores `params_json` opaque — **no server change**).
   Quantize nodes (e.g. int16 @0.1 mm) to keep it small.

**5. Tests (`tools/preview/`).**
   - `verify-cloth.mjs` (headless, no three): build a boxy tote's per-piece meshes + seamPairs, run
     `solveDrape`, assert **no NaN/Inf**, all seam pairs within tol after stitch-up, the result
     bbox is a plausible inflated box (≈ W×H×D, slightly rounded/larger than flat), and inflation
     increased the bag's girth/volume vs the un-inflated stitch. Reuse the fixtures from
     `verify-fold.mjs`/`verify-mesh.mjs`.
   - **The drape *look* and "doesn't explode on her real tote" are NOT auto-testable** — the gate.

## Gotchas (decided / flagged)
1. **Warm start is 80% of stability (§6.6.A).** Always seed from `foldDoc`'s `transforms`. If the
   fold degraded (`mode:"open"/"tree"`), the panels are still placed near their neighborhood —
   usable; the stitch-up pulls the rest closed.
2. **Per-seam flip** — derive from warm-start geometry (gotcha-0), don't assume a default.
3. **Open-top volume** — use per-face pressure, not enclosed-volume (the tote is open). See §6.4.
4. **Straps stay OUT of the sim** — `foldDoc` already excludes them; render via `addStraps`. Don't
   feed strap pieces to `triangulatePiece`/the solver.
5. **Velocity clamp ≈ 0.5·h and eased seam stiffness** are not optional — naive full-stiffness
   zero-length springs on far-apart panels → NaN (§6.6).
6. **Determinism** for the headless test (seed/avoid RNG).
7. **Node budget**: keep `h` so the whole bag is ~1–4k nodes; the "Fine" setting is the ceiling.

## Don't-break checklist
- **Print spine sacred:** `pattern-pdf.js`, `printing.py`, the tiler, the calibration gate, the
  SSRF guard, the print lock — untouched. The preview never calls a print endpoint.
- **Additive only:** the `preview3d` cache is an opaque `params` field (no DB migration); no schema
  bump needed for the cache. The solver/mesh fields are additive.
- **M1/M2/M3 + straps intact:** box preview (`verify-box-mesh.mjs` 18), rigid fold
  (`verify-fold.mjs` 62 + `verify-fold-mesh.mjs` 15), the strap handles — all stay green/working.
  After any `pattern-geom.js` touch, also run `tools/tiling/verify-*.mjs` (print regression).
- **three.js + poly2tri + Maker.js load only on `/preview`/`/edit`; `BASE_PATH` on every URL.**
- `pattern-cloth.js` is **pure (no three.js)** — three meets the cloth only in `preview3d.js`.

## How to work / verify / deploy
```bash
# headless (run all; extend, don't break)
cd ~/sewingapp/tools/preview && node verify-mesh.mjs && node verify-seam-correspondence.mjs \
  && node verify-cloth.mjs && node verify-fold.mjs && node verify-fold-mesh.mjs && node verify-box-mesh.mjs
cd ~/sewingapp/tools/tiling  && node verify-seams.mjs && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code baked into the image — rebuild after edits; rootless, no root)
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- **`curl localhost:8006` returns 000 here** (pasta IPv4-only + sandbox loopback) — smoke-test from
  inside the container: `podman exec -i sewingapp python - <<'PY' … urllib …` (in-container routes
  are **un-prefixed**: hit `http://127.0.0.1:8006/health`, `/preview/{id}`, `/static/js/...`).
- **Fixtures already in the DB:** id **2** "Smoke Tote" (freeform tote, 8 seams, no strap), id **3**
  "Strap Tote (preview test)" (tote + a side-to-side ×2 strap). Use them; author more as needed.
- **The gate is the owner's, hands-on on her *touchscreen laptop*** (Fedora KDE Plasma 44 — NOT an
  iPad; it's the same laptop she SSHes in from). The drape *look* + not-exploding have no automated
  oracle. **Done (3a):** tap Preview on a tote → a sewn, **inflated**, orbitable bag; reopen is
  instant (cache). Don't mark M4 done / update status docs / commit until she confirms.

## When her gate passes (not before)
Update `CLAUDE.md` Status + `PREVIEW.md` §9 (check off M4) + `HANDOFF-3d-preview.md`. Note any
still-deferred items (welding if skipped, true volume vs per-face pressure, fabric presets — those
lean into **M5** Step-3b garment-on-a-form). Then `git commit` + `git push` to `main`. The commit
rhythm: build → deploy → owner eyeballs → "looks good" → docs + commit.

---
## New asks for this session
> _(owner: add anything to adjust before/while building this.)_

**Outcome (2026-06-21):** built solver-first to a headless checkpoint (owner reviewed), then the
render/UI/cache, deployed, owner gated it — "looks really good." Inflation is a gentle, robust puff
(per-node tether, not raw pressure). Also fixed a reported span-strap `count×2` bug (it rendered a
parallel pair; a side-to-side spanning strap is one bridging handle regardless of cut count).
**Owner's one explicit follow-up: strap SNAP-TO-SURFACE — DONE 2026-06-22 ("connects perfectly").**
The drape view now snaps each handle anchor from the folded (warm-start) rim to the nearest settled
mesh node (`preview3d.snapToSurface`), so handles attach flush to the inflated surface. The fold view
keeps the raw rim anchors (its faces are at the folded rim). The next strap/M4-polish items are
plain-leather strap texture + (optional) welding/true-volume — all leaning into M5.
