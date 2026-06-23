# HANDOFF — set-in sleeve 3D drape (M6 Stage B1 → B2)

**Date:** 2026-06-23. **Status:** Stage A (drafting + 1:1 print) DONE + committed + owner-gated.
Stage B1 (sleeve drape) is **WIP committed** (works except the cap-shoulder join — see below).
**The owner's directive for the next session: build the ARMS (Stage B2) NEXT** — it will make the
cap-shoulder problem easier to see/solve AND likely improve the physics (the sleeve currently hangs
flat against the torso with nothing inside it → self-crumple, ambiguous to the eye; an arm gives it a
limb to drape over + self-separation).

Full design + locked decisions + risk list: `~/.claude/plans/can-we-add-a-dazzling-sky.md`.
The build is in `CLAUDE.md`'s status log. This file is the deep technical state of B1 + the B2 plan.

---

## What Stage B1 built (all in `app/static/js/pattern-cloth.js`; `SIM_VERSION 4→5`)

A sleeved garment now drapes. Everything is **garment-only**; the bag inflate path is byte-identical
(`verify-cloth.mjs` 26/26) and sleeveless garments are unchanged (`verify-garment-drape.mjs`). The four
pieces:

1. **`placeGarment` sleeve warm-start (two-pass).** Pass 1 places bodice/skirt panels as before and
   collects sleeves. Pass 2 places each sleeve by mapping its cap SEAMLINE onto the bodice armhole
   (read off the bodice's own wrap): the 3 cap landmarks — underarm-R(node2)→BACK-armhole-underarm,
   cap-top(node3)→shoulder, underarm-L(node4)→FRONT-armhole-underarm — ride an arch interpolation, and
   the sleeve body hangs straight down with an outward lean. `armOf(capEdge)` walks `seams` to find the
   connected bodice armhole edge; fallback = a tube beside the torso if no armhole seams. Detects L/R
   from the piece name (`/left/` → −X, else +X).
2. **Cap warm-start refine** (just before the mass block): after the cap pairs (`kIc/kJc`) are built,
   each sleeve cap-boundary node is **snapped onto its paired armhole node's warm-start position**
   (+4mm outward), so the cap starts ON the armhole (the arch alone left it 50–140mm off).
3. **Underarm self-seam stitching.** The seam loop used to `continue` on EVERY same-piece seam (only
   darts were handled). Now a same-piece seam with *different edges* (the sleeve underarm e1↔e4) sews
   as a normal SPRING via `seamPairs(mesh, eA, mesh, eB)` → `kI/kJ`. **Result: the tube closes to 0mm.**
4. **Cap-seam PHASING (the hard-won bodice fix).** A CAP seam = sleeve↔bodice (exactly one side a
   sleeve, `isSleeveId(a) !== isSleeveId(b)` — keyed on sleeve-involvement, NOT ease, so a 0-ease cap
   is phased too). Cap pairs go to a SEPARATE group `kIc/kJc` (not `kI/kJ`), so they're **out of the
   strain gate** (their residual is intended ease) AND **phased in time**: `substep` gained an
   `alphaCap` param; during the unpinned stitch-up the cap is INERT (`capOff=1e2` ≈ no force) so it
   can't drag the shoulder before it pins; then a zero-g **cap-attach** phase eases capOff→near-weld
   (`closeSeam1`) with the bodice armhole nodes momentarily anchored (`invm=0`) then released; Phase 2+
   hold the cap at near-weld. **Result: the bodice's own seams stay closed (0mm) — the cap no longer
   drags the shoulder open.** Without this, sewing the cap during the unpinned stitch-up reopens the
   (then-pinned) shoulder ~62mm (the same pinned-band mechanism as the M5c-step3 shoulder bug).

`isStrap`/`inferRole` are guarded so a long sleeve isn't pulled out as a strap (the `role!=="sleeve"`
guard in `placeGarment`, and `isSleeveId`). `verify-garment-drape.mjs` (now 54 checks) locks the working
properties; `preview3d.drapeToGroup` renders the sleeve sub-mesh with no change needed (piece-agnostic).

### Verified WORKING (headless, on a sleeved tank = the seeded id8 shape)
- Bodice own seams **0mm** (intact). Underarm tube **0mm** (closed). Body penetration **0mm**.
- `strain.overTension === false` (eased cap doesn't false-warn). `isStrapPiece(sleeve) === false`.
- Sleeves land outside the torso, R→+x / L→−x. ~**34/44 cap pairs <15mm** (mean ~18mm).
- **No regressions**: full preview + tiling suites green; print spine byte-identical.

### The OPEN problem — the cap-shoulder join
A cluster of cap pairs **near the shoulder settles ~100mm off the armhole** (worst pair, mean ~18mm).
The sleeve's hanging weight pulls the cap-top down off the armhole faster than the seam holds it, and a
stiff cloth mesh can't be dragged back by the boundary seam alone (the cap interior isn't seamed).

**Ruled out (all tested headless, see the repro below):**
- Warm-start distance — snapping the cap boundary exactly onto the armhole still settles to 100mm
  (the SOLVE pulls it apart, not the start).
- `capAttach` iteration count (24 / 60 / 120 — identical).
- Cap ease level (0.0 / 0.02 / 0.04 / 0.06 — identical; note 0-ease un-phased closes to 2.8mm but
  reopens the bodice, which is why phasing is keyed on sleeve-involvement not ease).
- Anchoring the bodice armhole nodes during the zero-g attach (no help).

**NOT yet tried (leads for the next session):**
- **Build the arms first (the owner's call).** With the sleeve draping OVER an arm capsule, the cap-top
  has a defined position (resting on the shoulder/upper arm) instead of hanging in free space, and the
  tube has self-separation. The owner expects this to largely resolve the gap + make it judgeable.
- Check the cap seam **flip/correspondence near the shoulder** (`deriveFlipWrapped` for the cap seams) —
  a cluster of mis-paired cap nodes (cap-top ↔ a far armhole node) would explain a persistent ~100mm
  that ignores stiffness/timing. Worth dumping the worst pairs' (cap local node, armhole local node).
- Balance sleeve node mass vs cap-seam stiffness, or sub-step the cap region.

### Repro (the scratch is gone with the session — recreate from `verify-garment-drape.mjs`)
The committed test `tools/preview/verify-garment-drape.mjs` (the "SET-IN SLEEVE" block) builds the exact
sleeved tank and asserts the working properties. To inspect the cap gap, add to that block:
`for (const [i,j] of rs.seamLinks) { /* categorize by np[i]/np[j]: sleeve↔bodice = cap; print d + min(y) */ }`
— cap pairs with `d>15` cluster at `y≈1346–1386` (shoulderY≈1386).

---

## Stage B2 — ARMS on the dress form (the next session's work)

From the plan file + the design pass. **Analytic capsule arms** (no mesh/SDF), mirroring the torso's
analytic collider. All in `body-form.js` + `preview3d.js` + a small `pattern-cloth.js` wrap tweak.

1. **`body-form.js` — arms in `loft(body, {arms})`.** Append `arms:[{side,p0,p1,r0,r1}]` to the return
   (NOT into `rings[]`). Each arm = a tapered round capsule: socket just outside the shoulder ellipse
   (`shoulder.a + r0·0.6`, dropped ~0.02·H), `armLen ≈ 0.30·H`, axis ~12° down-and-out (`±sin12°,
   −cos12°, 0`), radius from optional `body.bicepMm` (fallback `0.32·bustMm` ≈ 295mm), `wristC ≈
   0.58·bicepC`, `r = C/2π`. Gate arm generation on the doc having a sleeve (pass `{arms:true}`); the
   no-arms path must stay byte-identical (`verify-body-form.mjs` 34/34).
2. **Collision** — extend `insideForm` / `nearestSurface` / `signedDist` to test torso OR either arm
   (return the nearest of all). Point-to-tapered-capsule is closed-form: clamp `t=(p−p0)·axis/len` to
   [0,1], radial vector from the axis point, `signedDist = |radial| − (r0+(r1−r0)·t)`. Keep the
   SHARED-stack invariant (renderer + collider read the same descriptor — `group.userData.stack`).
3. **`preview3d.js`** — `dressFormGeometry`/`dressFormGroup` tessellate the capsules into the translucent
   form (same extended stack), shown only when a sleeve is present.
4. **`pattern-cloth.js`** — refine the sleeve `wrap` to follow the arm axis/radius (the current arch is
   the no-arms version). This is where the cap-gap likely improves: the sleeve wraps the arm, cap at the
   armhole/shoulder, body down the arm.
5. **`body.bicepMm`/`wristMm`** — additive passthrough in `pattern-geom.normalizeBody` (a NEW `body`
   field; only land it WITH arms). `geomHash` + `SIM_VERSION` bump.
6. **Tests** — extend `verify-body-form.mjs` (arms only when `{arms:true}`, no-arms byte-identical,
   capsule inside/3D-normal, render adds 2 meshes) + `verify-garment-drape.mjs` (sleeve wraps the arm,
   no capsule penetration). Hands-on owner gate (tunnelling check).

## Deploy / gate (per the owner-gate workflow + memory)
`podman build -t sewingapp . && systemctl --user restart sewingapp`; test inside the container via
`podman exec` (not localhost curl). Seeded **id8 "Example — Sleeved Tank"** is the live fixture
(`/preview/8`). Owner gates hands-on on her 1920×1080 touchscreen Fedora laptop before commit. Commit
direct to main (no PRs).
