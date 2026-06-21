# Handoff — Strap integration (fold her real strap into the bag)

> **For the next session.** Start in `~/sewingapp/`. Read, in order: `CLAUDE.md` (app guide +
> live status), `DESIGN.md` (architecture + locked decisions), `PRINTING.md` (the sacred print
> spine), `PREVIEW.md` (the 3D-preview build spec — esp. §2 invariants, §4 box, §5 fold), then
> this file. The app is live at `command.home.arpa/sewing/` (container `sewingapp`, port 8006).
> **M0–M3 are DONE, committed + pushed** (HEAD `1dd3435` on `main`). This task is the small,
> well-scoped follow-up the owner asked for after M3 cleared her iPad gate.

## The one-paragraph goal
The 3D preview now folds a freeform bag up from its seam graph (M3), and the *box* preview draws
a generic leather handle. But **her real patterns include an actual strap piece**, and when a bag
has straps they should appear as **real handles on the folded bag**, not a flat panel sticking out
(what the rigid fold does to a strap today) and not only the box's hard-coded ribbon. Make strap
pieces render as **flexible arched handles** anchored at their real sewn-on points, textured/colored
like the bag's other leather, so a folded tote previews *with its handles*. This is a render-layer
addition on top of M3 — **the rigid fold stays bag-only**; straps are a separate, non-rigid pass
(exactly how the box preview already treats them: panels + separate strap ribbons).

## Why a strap is special (don't fight the rigid solver)
A tote strap is a long thin band sewn to the bag at **both short ends** (e.g. the two ends of a
handle attach to the front top edge). That makes it:
- **Not rigid-foldable.** A flat rigid rectangle can't bow into a handle arch — real straps *drape*.
  If you feed a both-ends-sewn strap to `pattern-fold.js` as-is, its two seams form a cycle the
  rigid LM solver can't close (the strap would have to bend), so it degrades the whole bag to
  `mode:"open"`/`"tree"` with dashed "gap" lines across the handle. That's wrong.
- **The right model is the box's:** the box preview (`preview3d.js`) already draws straps as
  **flat ribbon bands following a binary-searched Bézier arch** whose arc length = the strap
  length, in the `LEATHER` material — *a shape cue, separate from the rigid panels.* Reuse that,
  but drive it from her **real strap piece + its real attach points** instead of the box params.

So: **identify strap pieces → exclude them from the rigid fold → render each as an arched band
between its 3D attach points.** The bag still closes cleanly; the straps ride on top.

## Where we are (what M3 built — don't relearn it)
- **`app/static/js/pattern-fold.js`** — pure/headless `window.PatternFold.foldDoc(pieces, seams, opts)`
  → `{ mode, transforms:{<id>:{pos,quat}}, root, cycles, closures, hinges }`. Spanning-forest BFS +
  forward kinematics + LM closure solve; **per-seam direction is searched**; degrade-never-blank.
- **`app/static/js/preview3d.js`** — `buildFoldedGroup(group, params, opts)` (the M3 freeform path):
  one `ShapeGeometry` face per piece placed by its `{pos,quat}`, `pieceFaceTexture(piece, unit)` for
  the outline, `addGapSeams` for unclosed seams, **outward-normal UV flip** so panel text reads
  forward. The **box** path is unchanged and still draws straps via:
  - `strapRibbonGeometry(curve, widthMm, samples=48)` (`preview3d.js:39`) — a flat band along a
    `THREE.Curve`, broad faces ±z, `DoubleSide`.
  - the box strap pass (`preview3d.js:~90–111`): `archFor(z)` binary-searches a `QuadraticBezierCurve3`
    control height so the arch's **arc length ≈ strapLenMm**; `LEATHER` (`0xb27c4f`) material; two
    bands at `±D/2`; `userData.kind = 'strap'`.
- **Straps in the document.** A boxy tote's strap is a piece **named `"Strap"`, `count:2`** (see
  `pattern-pdf.js:214`; when a saved `box` tote is opened in `/edit` it imports as freeform pieces
  via `G.piecesFromDoc`, so a freeform tote doc typically carries `"Strap"` pieces). Confirm against
  one of *her* real saved patterns before coding — check the actual piece names + how the strap is
  sewn (which edges have seams).

## What to build
**1. Identify strap pieces (decide the marker).** Two options — recommend supporting both:
   - **Explicit role (robust):** add an optional per-piece `role:"strap"` (additive schema field,
     defaulted in `clonePiece` like `notches`/`placements`) set from the editor's **Pieces panel**
     (a tiny Panel/Strap toggle). Stable, unambiguous, survives re-save.
   - **Auto-detect fallback (for existing docs):** a piece is strap-like if it's **long & thin**
     (bbox aspect ratio ≳ 4:1) **and** sewn to the rest only at its short ends (≤2 seams, each on a
     short edge), **or** its name matches `/strap|handle/i`. Use this when `role` is absent.
   Put the predicate in a pure helper (e.g. `G.isStrapPiece(piece, seams)` in `pattern-geom.js`, or
   a small fn in `pattern-fold.js`) so it's headless-testable.

**2. Exclude straps from the rigid fold (`pattern-fold.js`).** In `foldDoc`, drop strap pieces (and
   their seams) from the hinge graph / spanning forest / closure solve so the **bag closes cleanly**.
   Return strap info for the renderer, e.g. add a `straps: [{ piece:<id>, attach:[{seam, edge endpoints
   in the strap's local frame ...}] }]` field (additive — `mode/transforms/root/cycles/closures/hinges`
   unchanged). The renderer needs, per strap: which bag edges it's sewn to (its seams), so it can look
   up those edges' **3D world positions** from the bag `transforms`.

**3. Render straps as arched handles (`preview3d.js`, in/after `buildFoldedGroup`).** For each strap:
   - Find its seams to bag pieces; compute each attach edge's **3D midpoint** from the bag piece's
     `transform` (`pos + quat·(localMid)`), giving the two handle anchor points `P0`, `P1` in world.
   - Build a `QuadraticBezierCurve3` from `P0` up-and-over to `P1`, binary-searching the apex height
     so the **arc length ≈ the strap piece's long-dimension length** (reuse the `archFor` idea; the
     band width = the strap's short-dimension). Anchors are her real attach points (may be asymmetric),
     not the box's symmetric span.
   - Mesh it with `strapRibbonGeometry(curve, widthMm)`; material = `LEATHER` `MeshStandardMaterial`
     (matches the box handle + atelier look). `userData.kind = 'strap'`, `userData.pieceId`.
   - **Texturing is optional** for v1: a plain leather band reads as a real tote handle and matches
     the box. If desired later, map `pieceFaceTexture` along the band (U = arc length, V = width).
   - **Degrade gracefully:** strap sewn at only one end → anchor one end on the bag, free end arcs
     up/outward (or lay flat); strap with no bag seams → skip (or lay flat beside, like an orphan).

**4. Editor (optional, only if you add the explicit role).** A Panel/Strap control in the Pieces
   panel of `/edit` (`editor.js` + `edit.html`), writing `piece.role`. Mirror an existing per-piece
   control (cut-count / rename). Additive; round-trips via `freeformToDoc`/`normalizePieces`.

**5. Tests (`tools/preview/`).** Extend the headless suite:
   - `verify-fold.mjs`: a tote-with-strap fixture → the bag still `mode:"closed"` (strap excluded,
     doesn't degrade it); strap reported in the new `straps` field; bag `cycles` unchanged.
   - `verify-fold-mesh.mjs`: the freeform group has `kind:'strap'` band mesh(es) anchored near the
     bag top, arching **above** the bag bbox (like the box test's "straps arch above the box top").
   - strap-detection unit checks (aspect-ratio / name / role).

## Gotchas (decided / flagged)
1. **Don't let a strap poison the bag fold.** The whole point of step 2 is to pull straps *out* of
   the rigid graph before the LM solve. Verify the bag's `closures` are unaffected by adding a strap.
2. **Attach-point order / which strap end goes where.** A strap's two ends map to two bag edges via
   two seams; use the seam `anchors`/direction (same head-to-tail logic the fold already infers) to
   pick which strap end anchors at which bag edge so the band doesn't cross itself.
3. **Arc length vs straight-line span.** If the strap is *shorter* than the straight distance between
   its two attach points it can't arch — clamp (taut straight band) and don't NaN the binary search
   (guard like the box `archFor`).
4. **Two copies (`count:2`).** A tote has 2 straps (front + back). If the doc carries one `"Strap"`
   piece with `count:2`, decide where the second copy attaches (the back top edge) — mirror across
   the bag, like the box draws bands at `±D/2`. If she authored two separate strap pieces, each has
   its own seams — just render both.
5. **Texture/units.** If you texture the band, reuse `pieceFaceTexture`'s frame conventions + the
   shared unit (`localStorage["sewing.unit"]`). Plain leather avoids this entirely for v1.

## Don't-break checklist
- **Print spine sacred:** `pattern-pdf.js`, `printing.py`, the tiler, the calibration gate, the SSRF
  guard, the print lock — untouched. The preview never calls a print endpoint. Run
  `cd tools/tiling && node verify-editor-geom.mjs && node verify-browser-gen.mjs && node verify-seams.mjs`
  after any `pattern-geom.js` touch.
- **M3 intact:** the bag still folds + closes; `tools/preview/verify-fold.mjs` (33) and
  `verify-fold-mesh.mjs` (9) stay green (extend, don't break). The **box** preview (M1, `kind:"box"`)
  + `verify-box-mesh.mjs` (18) unchanged — its strap pass is the reference, leave it working.
- **Additive schema only:** `role` (if added) defaults like `notches`/`placements`; no DB migration
  (`params_json` is opaque). The `straps` solver field is additive.
- Maker.js + three.js load **only** on `/edit` and `/preview`; BASE_PATH on every URL.

## How to work / verify / deploy
```bash
# headless
cd ~/sewingapp/tools/preview && node verify-fold.mjs && node verify-fold-mesh.mjs && node verify-box-mesh.mjs
cd ~/sewingapp/tools/tiling  && node verify-seams.mjs && node verify-editor-geom.mjs && node verify-browser-gen.mjs
# build + deploy (code baked into the image — rebuild after edits; rootless, no root)
cd ~/sewingapp && podman build -t sewingapp . && systemctl --user restart sewingapp
```
- `curl localhost:8006` returns 000 here (pasta IPv4-only + sandbox loopback) — smoke-test the
  running container from inside it: `podman exec -i sewingapp python - <<'PY' … urllib …` (BASE_PATH
  is **not** prefixed on the in-container routes: hit `http://127.0.0.1:8006/health`, `/preview/{id}`,
  `/static/js/...`). A ready freeform tote example is saved as **id 2** ("Smoke Tote") — but it has
  **no strap piece**; author/import one of *her* real strap-bearing patterns to test this feature.
- **The gate is hers, on her real iPad** (the handle *look* has no automated oracle): open one of her
  tote patterns in Preview → **the bag folds closed AND shows real arched handles** anchored where the
  straps actually sew on; toggling a different floor/seam direction doesn't break the straps.

## When her gate passes (not before)
Update `CLAUDE.md` status + the relevant notes in `HANDOFF-3d-preview.md` / `PREVIEW.md` (mark strap
integration done; keep the still-deferred items noted: notch `{edge,t,type}` + anchors UI, dart
self-seams, atelier re-skin, then **M4** Step-3a inflated bag). Then `git commit` + `git push` to
`main` (remote `EWH2000/sewingapp`).

---
## New asks for this session
> _(owner: add anything to adjust before/while building this.)_
