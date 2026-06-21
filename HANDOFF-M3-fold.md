# Handoff — M3: Step 2 rigid fold-up (build it)

> **For the next session.** Start in `~/sewingapp/`. Read, in order: `CLAUDE.md` (app
> guide + live status), `DESIGN.md` (architecture + locked decisions), `PRINTING.md` (the
> sacred print spine), `PREVIEW.md` **§5** (the full Step-2 spec this handoff drives), then
> this file (the starting orders). The app is live at `command.home.arpa/sewing/` (container
> `sewingapp`, port 8006). **M0–M2 are DONE, committed + pushed** (HEAD `bd27061` on `main`).
> M3 is the next milestone and is **not started**.

## The one-paragraph goal
Make the preview **fold the bag up**. M2 gave us the **seam graph** (`seams[]`): which
authored edge of which piece is sewn to which. M3 turns that graph into a **rigid 3D
fold** — lay the root piece flat, hinge each sewn piece up by its seam's dihedral angle,
and **solve the closure** of the seams that form cycles (a bag's walls close a loop). The
result is the boxy tote shown *folded and closed* in the existing `/preview` page, replacing
today's "supports boxy totes so far" message for freeform docs that carry seams. This is the
**warm start** Step 3's cloth drape (M4/M5) needs, so the fold must be solid before M4.

## Where we are (what M0–M2 built — don't relearn it)
- **M0** — no-build three.js (r184) via a native import map; `/preview/{id}` page +
  `preview.js` (ESM entry). Vendored in `app/static/js/vendor/three/` (`three.module.js` +
  `three.core.js` + `addons/controls/OrbitControls.js` — a matched set; see its README).
- **M1** — `app/static/js/preview3d.js` (imports **only** `'three'`, so it's Node-importable):
  `docToMesh(pattern, opts)` builds a textured `THREE.Group` for **`kind:"box"`** (parametric
  tote: 5 panels + flat leather straps), `panelCanvasTexture(panel, unit)` renders a piece's
  flattened outline to a `CanvasTexture`, `frameObject(camera, controls, obj)` frames it,
  `contactShadow(W,D)`. Atelier studio look + a "finished measurements" spec plate. World =
  **y-up millimetres, base on the floor (y=0)** — keep this convention for the fold.
- **M2** — the **seam graph** (this is what M3 consumes):
  - `pattern-geom.js` (classic `window.PatternGeom`, eval'd in Node tests): top-level
    **`seams[]`**, `G.normalizeSeams(seams, pieces)`, **stable + unique piece ids**.
  - `editor.js` Sew mode authors seams (tap edge↔edge); round-trips through save + undo/redo.

## The data you get (schema 3) — read it, don't reshape it
A freeform doc (`kind:"freeform"`, in `pattern.params`):
```jsonc
{ "schema": 3, "kind": "freeform", "name": "...",
  "pieces": [ { "id":"p_base", "name":"Base", "count":1, "seamMm":10, "cornerRadius":0,
               "closed":true, "nodes":[{ "x":0,"y":0 }, …], "notches":[…], "placements":[…],
               "layout":{ "x":…, "y":… } }, … ],
  "seams":  [ { "id":"s_bf", "a":{ "piece":"p_base", "edge":0 }, "b":{ "piece":"p_front", "edge":0 },
               "foldAngle":90, "anchors":null } , … ] }
```
- **EdgeRef = `{piece:<id>, edge:i}`. Edge `i` = the boundary edge leaving node `i`** (segment
  `node[i] → node[(i+1)%n]`), on the **authored node polygon** — NOT the flattened (filleted)
  outline. For the **rigid fold, use the authored `nodes`** (panels are rigid polygons);
  curves/fillets are cosmetic here (a Step-3 drape concern). Texture faces with the flattened
  `G.pieceGeom(piece).cut` (M1's `panelCanvasTexture` already does this).
- **`foldAngle`** (deg): `0` flat, `+`valley, `−`mountain, **`null` = let the solver find it**
  (FOLD-spec convention). For a boxy tote the four base→wall seams are authored `90`.
- **`anchors`** (`[{ta,tb},…]` or `null`): matched arc-length fractions; `null` ⇒ the fold
  must pick the seam **direction** itself (see gotcha #1). Node coords are **local**; board
  coord = local + `piece.layout` (only used for 2D layout/print — the fold builds its own 3D
  pose, ignore `layout` for folding).
- The worked tote (5 pieces + 8 seams: 4 base-wall `90°` tree seams + 2 wall-ring **closure**
  seams with `null` angle) is spelled out in **`PREVIEW.md §3.6(a)`** — use it as the test
  fixture and the gate target.

## What to build (PREVIEW.md §5.2 is the algorithm)
**1. `app/static/js/pattern-fold.js` — pure/headless, NO three.js, NO DOM.** Make it a classic
IIFE attaching `window.PatternFold` (mirror `pattern-geom.js`) so the Node test can `eval` it
with a plain `window` shim and `preview3d.js` can read the global — **avoid** importing `'three'`
here (that's what forced the `three-resolver.mjs` hack for `preview3d.js`; keep the solver clean).
Return **absolute per-piece 3D transforms** (cleaner to render + test than scene-graph nesting):
```
G.PatternFold.foldDoc(pieces, seams) -> {
  mode: "closed" | "open" | "tree",          // degradation level reached
  transforms: { <pieceId>: { pos:[x,y,z], quat:[x,y,z,w] } },   // place each piece's local nodes
  root: <pieceId>,
  cycles: <int>,                              // #seams − (#pieces − 1) over the spanning tree
  closures: [ { seam:<id>, gapMm:<number> } ] // residual per non-tree seam (for the readout)
}
```
Steps (all deterministic, all unit-testable):
- **Hinge graph:** nodes = pieces, edges = seams. Validate each seam is *hinge-able* — its two
  paired authored edges have near-equal length (tol ~1–2 mm). Unequal ⇒ eased/gathered ⇒ not
  rigid ⇒ flag + degrade (it belongs to Step 3). `G.edgeLength(nodes[i], nodes[i+1])` is in
  `pattern-geom`.
- **Spanning tree + root:** root = largest-area piece (the base; `G.bbox`/shoelace area). **BFS**
  from root (shallow trees ⇒ less accumulated error). Tree seams → hinges; the rest → closure
  constraints.
- **Forward fold:** lay the root flat (z=0 plane, y-up). BFS-propagate: rigidly place each child
  so its paired edge coincides with the parent's hinge edge (2D placement in the parent's face,
  mirror per seam direction), then rotate the child's whole subtree about the hinge edge by the
  dihedral. After this pass every piece has a pose; closure seams just aren't sewn yet.
- **Closure solve (the cycles):** minimize `Σ‖r‖²` of the 3D endpoint gaps of each non-tree seam
  over the free tree angles, **Gauss–Newton / Levenberg–Marquardt**. Jacobian is analytic
  (`∂P/∂θ = ω × (P − pivot)`; perturbing one hinge rigidly rotates only its subtree) — no finite
  differences. Tiny problems (tote: ~5 pieces, ~2 cycles, <10 unknowns) → converges in a handful
  of iterations in pure JS. Authored angles are the initial guess + soft anchors; the solver
  moves `null` angles, with a weak regularizer `+μ Σ(θ−θ_pref)²` so a slack bag picks a nice fold.
- **Degradation ladder (never hard-fail, §5.3):** closes (‖r‖<tol) → `mode:"closed"`; nearly →
  `mode:"open"` (best-fit, report `gapMm`); can't-close / non-hingeable → `mode:"tree"` (tree is
  always foldable). No seams → flat layout.

**2. `app/static/js/preview3d.js` — the fold renderer (touch additively).** Add a path: for a
freeform doc **with seams**, call `window.PatternFold.foldDoc`, then build a `THREE.Group` where
each piece is a textured polygon (`THREE.ShapeGeometry`/triangulated `nodes`) placed by its
absolute transform; reuse `panelCanvasTexture` for the faces, `frameObject`, `contactShadow`.
Draw unclosed seams (mode `"open"`) as dashed "needs easing" lines and surface the mm gap.
Keep the existing **`kind:"box"`** parametric path (M1) unchanged. Freeform **without** seams ⇒
lay pieces flat in 3D (or keep a gentle message).

**3. `app/templates/preview.html` — load the solver.** Add `pattern-fold.js` to the **classic
defer stack** (after `pattern-geom.js`, before the import map + `preview.js` module), exactly
like `pattern-geom.js`. `preview3d.js` reads `window.PatternFold`.

**4. `app/static/js/preview.js` — route freeform+seams to the fold.** Today it shows a message
for `kind!=="box"`. Send freeform docs with `params.seams?.length` to the fold renderer; keep
the box path; keep graceful messaging for the empty/unsupported case.

**5. `tools/preview/verify-fold.mjs` — headless test.** Eval `pattern-geom.js` + `pattern-fold.js`
with a `window` shim (mirror `tools/tiling/verify-editor-geom.mjs`; no `three`, no DOM needed
since the solver is pure). Assert: a unit-cube **net folds to a closed cube** (closure residual
→ 0); the **worked tote closes** within tol; a **deliberately mismatched** panel degrades to
`mode:"tree"`; **BFS root + cycle count** are correct; transforms are rigid (preserve edge
lengths).

## Gotchas (decided / flagged — so you don't trip)
1. **Seam direction.** Which endpoint of edge `a` meets which of edge `b`? With `anchors:null`,
   adjacent pieces meet **head-to-tail** (opposite directions) — the common case. Implement
   direction inference (try both pairings, keep the one that folds consistently / smaller
   residual) **and** consider adding the **per-seam flip toggle in Sew mode** (deferred from M2,
   `editor.js`) now that the fold makes direction visible — wrong-direction seams are the most
   likely authoring error. Store the choice in `anchors` (the schema field already exists).
2. **Authored edges vs flattened outline.** The fold hinges on authored `nodes` (straight
   edges). `G.pieceGeom` flattens fillets/curves into many segments — use it only for the face
   **texture**, not the hinge geometry. (For a tote with rounded corners, the rigid fold still
   uses the 4 authored corners.)
3. **Keep the y-up, base-on-floor mm world** from M1 so the camera/lighting/shadow/spec-plate
   reuse unchanged. Root piece lies in the y=0 plane.
4. **Equal-length tolerance** decides hinge-ability; surface unequal seams as the ease signal,
   don't force them rigid.
5. **`pattern-fold.js` stays three-free + DOM-free** — that's what keeps `verify-fold.mjs` a
   simple eval (no `three-resolver.mjs`). `preview3d.js` is the only place three.js meets the fold.

## Don't-break checklist
- **Print spine sacred:** `pattern-pdf.js`, `printing.py`, the tiler, the calibration gate, the
  SSRF guard, the print lock — untouched. The preview never calls a print endpoint. Run
  `cd tools/tiling && node verify-editor-geom.mjs && node verify-browser-gen.mjs && node verify-seams.mjs`
  after any `pattern-geom.js` touch.
- **M2 intact:** seam authoring + `seams[]` schema + round-trip keep working; the box preview
  (M1, `kind:"box"`) still renders; `verify-box-mesh.mjs` (18) stays green.
- **Degrade, never blank:** tree-only fallback always; freeform-without-seams and box still work.
- **Schema:** additive only; `schema:3` already set when seams present. No DB migration.
- BASE_PATH on every URL; Maker.js + three.js load **only** on `/edit` (Maker.js) and `/preview`.

## How to work / verify / deploy
```bash
# headless tests
cd ~/sewingapp/tools/preview && node verify-fold.mjs        # new (after you write it)
cd ~/sewingapp/tools/preview && node verify-box-mesh.mjs    # M1 regression
cd ~/sewingapp/tools/tiling  && node verify-seams.mjs && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code is baked into the image — rebuild after edits; rootless, no root)
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- **`curl localhost:8006` returns 000 here** (pasta is IPv4-only + the Bash sandbox breaks the
  loopback receive). Test the running app from **inside the container**:
  `podman exec -i sewingapp python - <<'PY' … urllib …`. `BASE_PATH=/sewing` in the container.
- **The gate is hers, on her real iPad** (the fold *look* + touch orbit have no automated oracle).
  Don't mark M3 done / update status docs / commit until she confirms. Then update `CLAUDE.md`
  status + the M3 boxes in `HANDOFF-3d-preview.md` and `PREVIEW.md §9`, and `git commit` +
  `git push` to `main` (direct-to-main; remote `EWH2000/sewingapp`).

## M3 gate (PREVIEW.md §9)
Author the worked tote's seam graph in Sew mode (open a saved tote → it imports as pieces →
sew → Save) → open Preview → **watch it fold up and close**; a non-box bag with `null` angles
solves to a closed shape; a mismatched panel **degrades visibly** with a mm gap readout. Then,
and only then, M4 (Step 3a inflated bag) begins.

## Companion work you may pull in (optional, between/with M3)
- **Seam flip / anchor-direction UI** (deferred from M2) — pairs naturally with M3 (gotcha #1).
- **App-wide atelier re-skin** of the editor/home (DESIGN.md "Visual identity"; the preview is
  the first instance). Independent of the fold.

---
## New asks for this session
> _(owner: add anything to adjust before/while building M3.)_
