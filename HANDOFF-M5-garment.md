# Handoff — M5 / Step 3b: garment cloth-drape on a parametric dress form

> **For the next session.** Start in `~/sewingapp/`. Read, in order: `CLAUDE.md` (app guide +
> live status), `DESIGN.md` (architecture + locked decisions), `PRINTING.md` (the sacred print
> spine — never touched here), `PREVIEW.md` (the 3D-preview build spec — read **§3.3** the field
> spec for curves/darts/notches/gather/body, **§3.5** back-compat, **§5.1** Sew-mode UX, **§6.4**
> gravity, **§6.5** pinning + self-collision, **§6.6** the stability protocol, **§6.7** the dress
> form, **§6.8** garment placement + perf, and **§10** the owner-resolved open questions), then
> this file. The app is live at `command.home.arpa/sewing/` (container `sewingapp`, port 8006).
> **HEAD = `a16b709` on `main`** (remote `EWH2000/sewingapp`). **M0–M4 are DONE** (box preview →
> seam graph + Sew mode → rigid fold → strap integration → **inflated cloth drape + snap-to-
> surface**). M5 is the real destination: soft-body **garment drape**.

## The one-paragraph goal
Sew flat garment panels into a **draped** 3D garment under **gravity**, on a procedural **dress
form** sized from the wearer's measurements — the partner is making **skirts + tank-style
(sleeveless) dresses**. The whole on-ramp (seam graph, triangulation, the XPBD solver, stitching,
the settled cache) was built so M5 mostly **reuses** it: swap the bag's *inflation pressure* for
*gravity*, swap the bag's *rigid-fold warm start* for a *wrap-around-the-body placement*, add a
*body collider* + *fabric presets* + *self-collision*, and feed it the new garment **authoring**
features. This is the most uncertain stretch in the whole plan (~10–20 sessions; the placement +
stitch-up not exploding on real, hand-drawn garment patterns is where the hard patches live).
Build it solver-style: deterministic/headless pieces first (authoring lowering, the body form),
then the eyeball-gated drape; the owner's hands-on gate is the truth for the *look*.

## Owner decisions locked for M5 (resolved 2026-06-22 — don't relitigate)
- **Full §3.3 authoring** (her call): curves (Bézier necklines/armholes), **wedge + slash darts**,
  the upgraded **notch `{edge,t,type}`** + seam **anchors**, **ease/gather/pleat** on seams, and
  **variable per-node seam allowance** (`node.saMm`). The complete woven-garment authoring surface.
- **Authoring-first, preview follows.** Build the authoring (with print lowering + headless tests)
  so the doc can *represent* a dress; the drape preview then *consumes* whatever's authored. Don't
  ship a preview-only stub that fakes darts/curves.
- **Per-pattern measurements** — doc-level `body:{heightMm,bustMm,waistMm,hipMm}` (NOT a shared
  profile Setting). Owner's reason: she can change them per recipient, or when **making/selling for
  someone else**. Provide a sensible **default body** so a garment previews before she enters any.
- **Garment scope = sleeveless** (skirts, tank dresses). Sleeves/collars stay the **M6** escape
  hatch (a CC0 MPFB body + collider swap) — building sleeveless-first throws away nothing.
- **Example garments to seed** (for her exploration + your bug-testing): **an A-line skirt, a
  tank/sleeveless bodice top, and a tank dress.** (She did *not* ask for more bag variants.) These
  are authored once M5a exists, then seeded by a re-runnable script (below). The bags already in
  the DB stay: **id 3 "Strap Tote", id 4 "Smoke Tote".**
- **Fidelity** = a *believable shape preview to sanity-check before cutting* — explicitly **not** a
  photoreal digital twin (PREVIEW.md §10 Q6). Set expectations in the copy.

## What's already built that M5 REUSES (don't relearn it)
- **`app/static/js/pattern-cloth.js`** (`window.PatternCloth.solveDrape`) — the XPBD mass-spring
  core: distance(stretch)/bend/seam projection with per-type `compliance`, the §6.6 protocol
  (zero-gravity eased stitch-up, per-substep velocity clamp ≈`0.5·h`), settle/freeze, determinism,
  the `encodeDrape`/`decodeDrape`/`geomHash` cache codec. **M5 = the same solver with gravity
  instead of per-face pressure** (see "What to build" §3). Today it returns `{nodes, tris,
  pieceRanges, localUV, seamLinks, welds, mode, energy}`; v1 does **not** weld (stiff zero-rest
  seam springs → one piece per node → clean per-piece texturing).
- **`app/static/js/pattern-mesh.js`** — `triangulatePiece(piece,h)` (boundary→~h, interior Steiner
  grid, CDT, dist+bend constraints, `boundaryMeta:{edge,t}`) and `seamPairs(meshA,eA,meshB,eB,
  {flip})` (arc-length node pairing). Reused unchanged for garments.
- **`app/static/js/pattern-fold.js`** (`foldDoc`) — the rigid fold + strap handling. It is the
  **bag** warm start. **Garments do NOT rigid-fold** (an open bodice/skirt has no closed cycle to
  fold) — M5 needs a **new** warm start (wrap panels around the body). Keep `foldDoc` for bags; add
  a garment placement path (see §3). `isStrapPiece` + the strap handle render still apply if a
  garment ever has a tie/strap.
- **`app/static/js/pattern-geom.js`** — `pieceGeom(piece)` is the **single flatten** shared by
  print (`freeformToDoc`) and preview; `normalizePieces`/`normalizeSeams`; `nearestEdge`/
  `insertVertexOnEdge` (the edge-identity convention). **M5a extends `pieceGeom`/`pieceExtras` to
  lower curves/darts/variable-SA to `cut`/`seam` polylines** — the only place the new authoring
  touches the print path, and it stays additive.
- **`app/static/js/preview3d.js`** — `drapeToGroup(pattern, solveResult, fold, opts)` (pattern-
  textured per-piece render + per-piece outward U-flip + `snapToSurface` strap snap), `frameObject`,
  `contactShadow`, `pieceFaceTexture`. M5 adds a **dress-form mesh** + a garment drape path.
- **`app/static/js/preview.js` + `preview.html`** — the `/preview/{id}` page: Fold⇄Inflated toggle,
  Preview-detail control, "Settling…" badge (double-rAF), the in-doc settled cache. M5 adds a
  **Measurements panel** + (for garments) a fabric-preset control, and routes garments to the drape.
- **`app/static/js/editor.js` + `/edit`** — Sew mode (edge↔edge seams, per-seam fold angle, flip),
  Notch mode, the Pieces panel. **M5a extends the editor** with the §3.3 authoring tools.

## What to build (sub-milestones — each is an owner-gated stop point)

### M5a — Garment authoring (schema-3 §3.3, full) + print lowering + measurements
Make the document able to *represent* a dress, with every new feature **lowering to the existing
`cut`/`seam` line-kinds before `freeformToDoc` builds `paths`** so the print spine never changes.
All fields are additive/optional; bump `schema:3` only when a schema-3 field is present.
- **Curves** — per-piece sparse `edges:{ "<startNodeIdx>": { curve:{type:"quad"|"cubic"|"arc",
  cp:[…] } } }`, control points in the **edge-local frame** (chord=X, left-normal=Y, scale-/
  translate-invariant). `pieceGeom` flattens via Maker.js at the same chord tol as fillets →
  print and drape consume one flatten. Editor: tap an edge → make it a curve, drag a control
  handle on the SVG canvas (the trickiest new UI; mirror the node-drag interaction).
- **Darts** — per-piece `darts:[{id,edge,center,width,depth,kind:"wedge"|"slash"}]`. A **wedge**
  dart splits its edge at `center±width/2`, drops an apex `depth` into the interior; the two new
  legs become `cut` outline **plus a self-`seam`** (both refs on the same piece) that the drape
  sews shut to shape the panel. A **slash** dart draws interior fold lines only. Both lower in
  `pieceGeom`/`pieceExtras`. Editor: tap an edge → place/size a dart.
- **Notches upgrade** — `notches:[{edge,t,type:"single"|"double"}]` (legacy `{x,y}` loads via
  `nearestEdge`, converts on first save — §3.5). Notches **are** the seam anchors; `double` marks
  "back" so a seam can't be sewn reversed. Editor: Notch mode sets `t` + type.
- **Seam anchors / ease / gather** — `seam.anchors:[{ta,tb}]` (seed from matched notches via a
  "match notches" action in Sew mode → arc-length sub-span matching), `seam.ease` (number), and
  `seam.gather:{type:"gather"|"pleat", ratio, region}` / pleat. Drape resamples the long edge onto
  the short within each sub-span; print may emit gather balance-notches as `cut` ticks.
- **Variable seam allowance** — optional `node.saMm` overriding the piece `seamMm` (wider at a hem).
- **Measurements** — doc-level `body:{heightMm,bustMm,waistMm,hipMm}`. A **Measurements panel** (on
  `/edit` and/or `/preview`) writes it; **default** to a standard adult so a garment previews with
  no entry (the PREVIEW.md §3.6(b) numbers — `1650/920/740/980` — are a fine default). Per-pattern,
  rides the opaque `params_json`.
- **Tests** (`tools/tiling/` for print-side, `tools/preview/` for geometry): schema-3 normalize +
  back-compat (notch `{x,y}`→`{edge,t}`; schema-1/2 still load); **edge-identity stable** under a
  curve edit / dart add / node move (a seam doesn't silently retarget); dart self-seam emission;
  curve flatten identical in print and preview; gather notch placement. **Run
  `tools/tiling/verify-browser-gen.mjs` + `verify-editor-geom.mjs` after ANY `pattern-geom.js`/
  `pattern-pdf.js` touch** (print regression).
- **Gate:** she can author a curved neckline + a bust dart on a bodice and **print it 1:1**
  unchanged; the doc round-trips through save/undo/redo. (No drape yet.)

### M5b — `body-form.js`: the parametric dress form (pure/headless first)
New `window.BodyForm` (mirrors `pattern-mesh.js`/`pattern-fold.js` — **no three.js, no DOM**). Loft
a limbless torso from a hand-authored 2D silhouette profile through a stack of **elliptical**
cross-section rings; each of bust/waist/hip solves the ring `(a,b)` semi-axes for the target
circumference (Ramanujan's perimeter approx) at a fixed depth:width aspect, Catmull-Rom
interpolated between bands; height scales the Y extent. Export:
- a ring stack the renderer turns into a `BufferGeometry` (three.js has no loft — generate it
  directly, NOT `LatheGeometry`, which only does circular sections);
- **analytic collision** (§6.7, following GarmentCodeData — no SMPL, no mesh/SDF): `insideForm(p)`
  (look up ring `(a,b)` by height, test `(x/a)²+(z/b)² < 1`) and `nearestSurface(p)` (project to
  the ellipse boundary + a few-mm skin offset). O(1), no BVH.
- **Test** `tools/preview/verify-body-form.mjs`: ring circumferences match the measurements;
  `insideForm` true/false on known points; re-loft on a measurement change is correct.
- Render a **translucent form** in `preview3d.js` so she can see the garment on it.
- **Gate:** entering measurements re-lofts a believable form in the preview (<1 ms), sized right.

### M5c — gravity drape (reuse the XPBD solver) — the make-or-break
Extend `solveDrape` with a **garment mode** (or a sibling `solveGarmentDrape`) that, vs the bag:
- **Gravity ON, pressure OFF.** Rest shape = the flat panel (the research convention). Scale `g`
  to mm units and the substep formulation; tune so cloth hangs, doesn't free-fall through the
  clamp. Fabric **presets** (cotton/denim/silk) set stretch/bend `compliance` + node mass (weight).
- **Warm start = wrap around the body, NOT `foldDoc`.** An open garment has no closed fold. Walk
  the seam graph from the top (shoulder band height); wrap each panel around the form's ellipse at
  its band (front panel → front half, back panel → back half) so cloth starts **outside** the body
  (§6.8). **This placement is the M4-stitch-up-equivalent risk** — get panels close + outside, or
  the stitch-up/collision explodes. Degrade-never-blank: if placement fails, fall back to laying
  panels flat in front of the form.
- **Body collision** — per node, if `insideForm`, project to `nearestSurface` + skin offset (a
  one-sided XPBD constraint). Analytic, O(1) per node.
- **Self-collision** — a uniform spatial hash at cell≈`h`, node-node repulsion under fabric
  thickness; **only in final settle passes** (off during stitch-up).
- **Pinning** — `invMass=0` at shoulders/waistband during warmup, **released after N frames**
  (mark via `place3d`/`placements`/a `pins[]`).
- **Darts collapse via self-seams** — ⚠️ the current solver **skips same-piece seams**
  (`if (s.a.piece === s.b.piece) continue;` in `solveDrape`, and `foldDoc` sets `selfSeams` aside).
  M5 must **enable self-seams**: pair nodes across the two dart-leg edges **within one mesh** (a
  same-piece `seamPairs`) and add zero-rest constraints, so the dart sews shut and shapes the panel.
- **Render** — reuse `drapeToGroup` (pattern-textured per-piece); add the form mesh behind it.
- **Tests:** the deterministic parts only (seam correspondence across unequal/eased edges; dart
  self-seam pairing; collision projection pushes an inside point out; no NaN on the example
  garments). **The drape *look* + "doesn't explode on her real dress" are NOT auto-testable** — the
  owner gate (per §6.6/§7).
- **Gate:** a tank top / skirt drapes believably on a measurement-fit form; a bust dart visibly
  shapes the bodice; fabric presets visibly change the hang; reopen is instant (the existing cache).

### Example garments (seed once M5a authoring exists)
Author **an A-line skirt** (two panels, side seams + a waistband; gentlest drape), **a tank/
sleeveless bodice** (front+back, shoulder+side seams, curved neckline+armholes, a bust dart), and
**a tank dress** (bodice + skirt joined at the waist — the flagship). Seed them with a **re-runnable,
idempotent script** `tools/seed-examples.mjs` (or a `/dev`-gated route) that `POST`s each doc to
`/patterns` **only if a pattern of that name doesn't already exist** (so re-running is safe and she
can delete/recreate). Keep the existing bags (id 3, id 4). These double as the visual regression
corpus (§7) even though their pass/fail is by eye.

## Gotchas / the hard parts (decided / flagged)
1. **Garment placement is the make-or-break** (the M4 stitch-up's equivalent). No rigid fold —
   wrap panels around the body bands so they start close + outside. 80% of stability is placement.
2. **Self-seams must be ENABLED for darts** — the solver currently skips `a.piece===b.piece`. A
   dart is a same-piece zero-rest seam. Don't forget this or darts won't collapse.
3. **Print spine sacred.** Curves/darts/notches/variable-SA all lower to `cut`/`seam` in
   `pieceGeom`/`pieceExtras` **before** `paths`. `pattern-pdf.js`/the tiler/`printing.py`/the
   calibration gate/the SSRF guard never learn the new fields. Run the tiling tests after touching
   `pattern-geom.js`.
4. **Edge identity** (§3.2) — every new ref (seam/dart/notch) addresses an **authored node-edge**
   (`edge i = node i→i+1`), never a flattened-segment index. A curve/radius change must NOT
   retarget a seam. Test this.
5. **Back-compat** — legacy notch `{x,y}` → `{edge,t}` on first save; schema-1 (single `nodes`) and
   schema-2 (pieces, no seams) docs must keep loading + printing unchanged.
6. **Measurements default** so a fresh garment previews without forcing entry; per-pattern, opaque.
7. **Perf (iPad, honest)** — ~1–4k nodes whole-garment, settle-once (a second or two), single-
   threaded; the detail slider + cache already exist. Self-collision is the cost — keep it to final
   passes. WebGPU/TSL is an **M6** accelerator, not now (Safari single-thread reality, §6.8).
8. **Determinism** for the headless tests (seed/avoid RNG), as in `pattern-cloth.js`.
9. **Degrade, never blank** — bad placement → panels flat in front of the form; unsolvable drape →
   fall back to the rigid fold (bags) or the flat layout. No blank screen.

## Don't-break checklist
- **Print spine + calibration gate + SSRF guard + print lock: untouched.** The preview is
  read-only of the doc and never calls a print endpoint.
- **Additive only:** schema-3 fields optional; the `preview3d` cache is opaque `params` (no DB
  migration). Server stays a dumb store/relay.
- **M1–M4 intact:** box preview, rigid fold, strap handles + snap, inflated bag, the cache — all
  stay green/working. Full headless suite (`tools/preview/verify-*.mjs` + `tools/tiling/verify-*.mjs`)
  green before each commit.
- **Pure modules stay DOM-free** (`pattern-cloth.js`, `pattern-mesh.js`, `pattern-fold.js`,
  `body-form.js`) so the `.mjs` tests can `eval` them. three.js meets them only in `preview3d.js`.
- **three.js + poly2tri + Maker.js load only on `/edit`/`/preview`; `BASE_PATH` on every URL/fetch.**

## How to work / verify / deploy
```bash
# headless geometry tests (extend, don't break)
cd ~/sewingapp/tools/preview && node verify-mesh.mjs && node verify-seam-correspondence.mjs \
  && node verify-cloth.mjs && node verify-cloth-mesh.mjs && node verify-fold.mjs \
  && node verify-fold-mesh.mjs && node verify-box-mesh.mjs && node verify-body-form.mjs   # (new)
cd ~/sewingapp/tools/tiling  && node verify-seams.mjs && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code baked into the image — rebuild after edits; rootless, no root)
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- **`curl localhost:8006` returns 000 here** (pasta IPv4-only + sandbox loopback) — smoke-test from
  inside the container: `podman exec -i sewingapp python - <<'PY' … urllib …` (in-container routes
  are **un-prefixed**: `http://127.0.0.1:8006/health`, `/preview/{id}`, `/static/js/...`,
  `POST /patterns`). Seed/inspect example docs this way.
- **`sudo` is unavailable** here — if a root step ever comes up, hand the user exact commands for
  their root SSH session.
- **The gate is the owner's, hands-on on her *touchscreen laptop*** (Fedora KDE Plasma 44 — NOT an
  iPad). The drape *look* + not-exploding on her real patterns have no automated oracle. Commit
  rhythm: build → deploy → owner eyeballs → "looks good" → update status docs → **commit + push
  directly to `main`** (these single-host projects don't use PRs/branches).

## When her gates pass (per sub-milestone, not before)
Update `CLAUDE.md` Status + `PREVIEW.md` §9 (check off M5 / its sub-steps) + `HANDOFF-3d-preview.md`.
Note any still-deferred items (sleeves/collars → M6; WebGPU/TSL → M6; whatever authoring polish
slips). Then `git commit` + `git push` to `main`.

---
## New asks for this session
> _(owner: add anything to adjust before/while building this. The big decisions — full authoring,
> per-pattern measurements, the three example garments, sleeveless-first — are locked above.)_
