# Handoff — M5c polish (self-collision + settle tuning) + the interactive editor authoring UI

> **For the next session.** Start in `~/sewingapp/`. Read, in order: `CLAUDE.md` (app guide + live
> status — the M5a/M5b/M5c entries at the end are the current state), `DESIGN.md`, `PRINTING.md`
> (the sacred print spine — never touched), `PREVIEW.md` (the 3D-preview build spec), the original
> `HANDOFF-M5-garment.md` (the M5 starting orders + the still-valid §3.3 field spec), then this
> file. App is live at `command.home.arpa/sewing/` (container `sewingapp`, port 8006). **HEAD =
> `53b3b1b` on `main`** (remote `EWH2000/sewingapp`).

## Where we are (all owner-gated + committed this session)
The garment drape is **working end-to-end**: author flat panels (curves + darts + measurements) →
print 1:1 → preview them **draped on a parametric dress form under gravity**, with the bust dart
shaping the bodice. Four committed milestones since `39c90fe`:

- **M5a — garment authoring foundation** (`6655eb3`). `pattern-geom.js`: curves (`edges` map,
  Maker.js Bézier/Arc), darts (`piece.darts[]`, pure `G.loweredBoundary` cuts the wedge **without
  mutating `piece.nodes`**), variable per-node SA (`node.saMm`), notch upgrade `{edge,t,type}`,
  doc-level `body`, schema bump — **all lower to `cut`/`seam` before the print path; schema-2 docs
  byte-identical**. Editor preserves the new fields through load/save/undo (`restore` →
  `normalizePieces`). 3 seeded garments (id 5 A-line Skirt, id 6 Tank Bodice, id 7 Tank Dress) via
  `tools/seed-examples.mjs` (host-side, idempotent). **Darts live in `piece.darts[]`, NOT derived
  into `seams[]`** — see the `sewing-m5a-dart-representation` memory.
- **M5b — parametric dress form** (`a8e5ae4`). `body-form.js` (`window.BodyForm`, pure): lofts an
  elliptical torso from `body` measurements (Ramanujan inverse at fixed aspect; floats at anatomical
  heights so a skirt hangs below the waist); analytic collision (`insideForm`/`nearestSurface`).
  `preview3d.dressFormGroup` (translucent muslin; `group.userData.stack` shared with the solver).
  Live `#pv-measure` panel on `/preview`.
- **M5c-step1 — gravity drape** (`d205773`). `solveDrape` `opts.garment` branch (bag inflate path
  byte-identical): `placeGarment` wraps panels on the form, gravity replaces pressure, one-sided
  body collision (`projectBody`, pseudo-friction grip), pins the top edge, fabric presets
  (`#pv-fabric`). `geomHash` grows bag-safe.
- **M5c-step2 — dart shaping** (`53b3b1b`). `triangulatePiece` cuts the wedge + tags legs;
  `selfSeamPairs` pairs them; the garment branch **welds** them (`projectWelds`) so gravity can't
  reopen the dart (2.1mm closed; +80mm bust depth). `SIM_VERSION 1→2`.

## The architecture you're extending (don't relearn it)
- **Pure modules** (DOM-free, three-free, eval'd by headless tests): `pattern-geom.js`,
  `pattern-mesh.js`, `pattern-fold.js`, `pattern-cloth.js`, `body-form.js`. three.js meets them only
  in `preview3d.js`.
- **The solver** `pattern-cloth.solveDrape(pieces, seams, opts)`: bag inflate vs `opts.garment`
  gravity drape (gated on `garment` so the bag path is byte-identical — `verify-cloth.mjs` is the
  regression sentinel). The garment driver: warm-start wrap → zero-g eased stitch-up (pins on, dart
  welds active) → gravity ramp + body collision → settle. Forces are closure vars (`gAccel`,
  `collideOn`, `weldI/weldJ`) read by `substep`.
- **World**: y-up mm; the form floats (hem ~0.42·height, shoulder ~0.84·height); a contact shadow
  sits on the floor under it.
- **Cache**: settled drape in `params.preview3d` (opaque), keyed by `geomHash` (now includes
  body/fabric/darts) + `SIM_VERSION`. Edit/measurement/fabric change → re-solve.

## Known rough edges (the "weird small bugs" — investigate first)
1. **The drape freezes "warm", not "settled"** — `solveDrape` returns `mode:"warm"` for the
   garments (energy never drops below `settleTol = 0.015·h` within `maxSettle=360`). The frozen
   frame may look **slightly wavy / not fully relaxed**. Most likely the single biggest visual
   nit. Options to try: more settle substeps; more `damp`; a final few high-iteration relaxation
   passes; or accept it and lower the convergence bar. Tune via `opts` first (no code edit needed:
   `maxSettle`, `damp`, `settleIters`), then bake the winner into the garment defaults.
2. **The bodice hem hangs ~140mm below the waist** — only the shoulders are pinned, so the waist
   edge droops under gravity (host-side: bodice y-span 919–1386, waist at 1023). Reads a touch
   long. If she wants it to sit at the waist, pin/anchor the waistline too, or add light friction.
3. **Waistband / finishing strips are EXCLUDED from the drape** (placeGarment skips
   `waistband|binding|facing|band` by name) — intentional (they cluttered), but it means they're
   invisible in 3D. Fine for now; note it if she asks "where's the waistband."
4. **Dart-on-a-seam-edge** (the tank dress: the bodice waist edge has BOTH the bust dart AND the
   waist seam to the skirt) degrades gracefully — the inter-piece seam pairing skips the dart-mouth
   gap on that edge. Works, but the bodice↔skirt waist join near the dart may be slightly imperfect.
   Worth an eyeball on id 7.
5. **No self-collision yet** — cloth can pass through itself in tight folds (front/back are kept
   apart by the body, so it's mostly fine, but a deep gather could self-intersect).
6. **Curve sign convention**: a curve's `cp=[u,v]` is in the edge-local frame (chord=X, **left-
   normal**=Y). For the seeded necklines/armholes, **positive v bows inward** (the editor drag-
   handle, when built, just needs to write back the dragged point's local `[u,v]` — see
   `editor`-side note below).

## What to build next (two independent chunks — pick by what she wants)

### A) M5c-step3 — self-collision + settle tuning (finish the drape quality)
- **Settle tuning** (do this first — cheapest, biggest visual win): get the garment to `mode:
  "settled"` or at least visually still. Sweep `maxSettle`/`damp`/`settleIters` via `opts` against
  the 3 seeded garments host-side (see the solve harness below), pick values, set garment defaults
  in `pattern-cloth.DEFAULTS`/the garment branch.
- **Self-collision**: a uniform spatial hash at cell≈`h`, node-node repulsion under a fabric
  thickness, **only in the final ~20–40 settle substeps** (off during stitch-up — it's the
  expensive part), `opts.selfCollide`-gated. Skip mesh-adjacent neighbors. Deterministic iteration
  order (integer keys, index order — no Map-order reliance). Add `projectSelfCollision()` as a
  `substep` step like `bodyProject`. Test: two overlapping nodes get pushed apart; determinism
  holds; no NaN on the 3 garments. Keep it cheap (iPad budget — though she gates on a laptop).
- Plain-leather **strap texture** (long-deferred from M4) can ride here if time.

### B) The interactive editor authoring UI (so she can DRAW curves/darts, not just seed them)
The data model + print lowering are **done**; this is **additive UI** on `/edit` (`editor.js` +
`edit.html`). The owner can currently only get curves/darts via the seed script. Build (from the
original `HANDOFF-M5-garment.md` §M5a / PREVIEW.md §3.3):
- **Curve drag-handle** (the trickiest — mirror the node-drag interaction): a "Curve" toolbar
  toggle; tap a straight edge → quad curve; drag a control dot on the SVG canvas → write
  `piece.edges[edge].curve.cp` (invert the edge-local transform: `u=(P−a)·d/|d|²`,
  `v=((P−a)·n̂)/|d|`). `pieceGeom` already renders it.
- **Dart placement**: a "Dart" toggle; tap an edge → add `{edge,center,width,depth,kind:"wedge"}`;
  a small card sets the params.
- **Notch t/type**, **"match notches" + ease/gather** in Sew mode.
- **Measurements card** on `/edit` (mirror the `/preview` `#pv-measure`; `state.body` already
  round-trips via `buildDoc`/`restore`).
- **Critical sync point**: any new per-piece field must be carried by `clonePiece` (it is) AND the
  editor's `restore` (now routes through `normalizePieces` — so it's automatic; keep it that way).

## How to work / verify / deploy
```bash
# headless suite (all green at HEAD; extend, don't break)
cd ~/sewingapp/tools/preview && for t in verify-mesh verify-seam-correspondence verify-cloth \
  verify-cloth-mesh verify-fold verify-fold-mesh verify-box-mesh verify-lowering verify-body-form \
  verify-garment-drape; do node $t.mjs; done
cd ~/sewingapp/tools/tiling  && node verify-seams.mjs && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code baked into the image — rebuild after edits)
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- **`verify-cloth.mjs` (bag) + the `tools/tiling` suite (print spine) are the regression sentinels**
  — they MUST stay byte-identical green. The bag path / print path are sacred.
- **Host CAN reach the container** here: `node`/`python` HTTP to `http://127.0.0.1:8006` works
  (curl returns 000, but fetch/urllib don't). `node` is NOT in the container (Python only) — run
  `.mjs` host-side. **Solve harness** (host-side, the pattern I used to debug the drape all session):
  ```bash
  node --input-type=module -e '
  import { readFileSync } from "node:fs"; import { createRequire } from "node:module";
  const require = createRequire("/home/ehill/sewingapp/tools/tiling/");
  global.window = { makerjs: require("makerjs") };
  const APP="/home/ehill/sewingapp/app/static/js";
  for (const f of ["vendor/poly2tri.js","pattern-geom.js","body-form.js","pattern-fold.js","pattern-mesh.js","pattern-cloth.js"]) eval(readFileSync(`${APP}/${f}`,"utf8"));
  const Cl=global.window.PatternCloth, BF=global.window.BodyForm;
  const pat=await (await fetch("http://127.0.0.1:8006/patterns/6")).json();
  const r=Cl.solveDrape(pat.params.pieces, pat.params.seams, {h:20, garment:true, body:pat.params.body, fabric:"cotton"});
  console.log(r.mode, r.energy, r.nodes.length); '
  ```
- **The gate is the owner's, hands-on on her touchscreen laptop** (Fedora KDE — NOT an iPad). Drape
  look has no automated oracle. Rhythm: build → deploy → she eyeballs → "looks good" → update
  `CLAUDE.md` Status + `PREVIEW.md` §9 → **commit + push directly to `main`** (no PRs/branches).

## Deferred (track, don't lose)
M5c self-collision + settle tuning + strap texture (chunk A above); the interactive editor authoring
UI (chunk B); sleeves/collars → M6 (CC0 MPFB body + collider swap); WebGPU/TSL → M6. Per-corner
radius, SVG/DXF export polish, overlap warnings — pre-existing backlog in `CLAUDE.md`.
