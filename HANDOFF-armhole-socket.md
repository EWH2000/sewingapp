# HANDOFF — Armhole socket (close the cap-to-shoulder join)

**Goal:** make the set-in sleeve preview *production-worthy* by closing the
**cap-to-shoulder gap**. Today the sleeve wraps the arm beautifully (the bottom),
but where the sleeve cap meets the bodice shoulder there is a soft ~85 mm gap
(the top). The owner reviewed it ("pretty close, but it needs the armhole socket
to be production worthy") and asked for this dedicated session.

The fix is **geometric, not solver tuning** — I proved tuning can't close it
(evidence below). The dress form needs a real **armhole socket** so the arm root
and the bodice armhole *coincide*, instead of the arm being bolted onto a smooth
torso side ~64 mm outboard of the armhole.

---

## 0. Where things stand (committed)

- Branch `main`, commit **`3a1d9c8`** "Set-in sleeves Stage B2 (WIP): dress-form
  arms + sleeve wraps the limb". Deployed (container rebuilt, `systemctl --user
  restart sewingapp`), **SIM_VERSION = 9**.
- The seeded sleeved fixtures live at **`/preview/8`** ("Sleeved Tank", id 8) and
  **`/preview/7`** ("Tank Dress", id 7). Open → **Draped**.
- **WORKS (don't regress):** both sleeves wrap ~355° around their arm, mirror-
  symmetric, fabric on the top *and* underside (not a pouch); bodice's own seams
  stay closed (~0 mm); underarm self-seam zips; body penetration ≲16 mm; cap
  region de-crumpled (self-overlap pairs 4→1 vs the version the owner first saw).
- **OPEN (this session):** cap-to-shoulder gap ~85 mm (a soft hole at each
  shoulder — see `ArmsIssue2.png`/`ArmsIssue3.png` in the repo root, the owner's
  screenshots of the gap/residual mess at the top).
- Full headless suite is green. The **print spine + calibration gate are
  byte-identical** (this whole stage never touched `pattern-pdf.js`,
  `printing.py`, `pattern-geom.js`, `pattern-fold.js`, `pattern-mesh.js`,
  `main.py`, `models.py`, `db.py`). Bags + sleeveless garments byte-identical.

---

## 1. The problem, measured exactly (tank fixture, default body 1650/920/740/980)

After the bodice wraps onto the form, the **bodice armhole** (the bodice nodes
the sleeve cap sews to) is a **tall vertical slit on the side of the torso**:

```
R armhole 3D:  x[111 .. 166]   y[1186 .. 1374]   z[-60 .. 61]   center ≈ [138, 1280, 1]
```

The **arm capsule** (from `body-form.js buildArms`) is bolted on outboard:

```
R arm:  socket p0 = [172, 1353, 0]   wrist p1 = [316, 675, 0]   r0 = 43   r1 = 25
        arm-top SURFACE at the socket ≈ x 214   (= p0.x + r0·eTop.x, eTop.x≈0.977)
```

Body reference at the shoulder band: `sh.a` (shoulder half-width) ≈ **135**;
bust half-width ≈ **170**.

**The gap:** the cap-top sews to the armhole shoulder S (≈ x150) but the sleeve
must then wrap the **arm top at x≈214** — a **~64 mm horizontal reach** over only
~20 mm of vertical fabric. That reach is the gap. It's there because:
- the **armhole is a vertical slit** (oriented in a roughly vertical plane), while
  the arm-root ring the sleeve wraps is roughly **horizontal** (⊥ the down-pointing
  arm) — they're nearly perpendicular; and
- the arm **must** be outboard (x≈172, surface to 214) to clear the torso: a
  vertical arm right under the armhole (x≈138) would be **inside the bust** (170).

So the armhole and the arm don't co-locate, and the cap can't bridge cleanly.

---

## 2. Why solver tuning can't fix it (don't re-run these — they're dead ends)

I swept everything; the cap-shoulder gap is pinned at ~85 mm:

| lever | range tried | cap-shoulder gap | note |
|---|---|---|---|
| arm-hug tether cap | 8–32 mm | 85–87 | invariant |
| cap→arm blend length | 60–300 mm | 84–87 | invariant |
| cap-attach iterations | 24–120 | 85 | invariant (gravity undoes it) |
| tether the cap edge to armhole | cap 12–16 | 75 but **bodice opens 33–38 mm** | drags the bodice |
| tether the cap edge, loose | cap 24–32 | 70–72, bodice 0 | but **crumple worse** (close pairs 9) |
| **move arm inboard** `socketOut 0.85→0.4` | — | 68 but **bodice opens 74 mm**, pen 33 | punches through torso |
| move arm inboard + up + steeper | so 0–0.4, deg 18–25 | 79–92 or bodice 56–74 | **no clean window** |

**Conclusion:** moving the arm toward the armhole closes the gap *only* by driving
the arm through the torso surface, which makes the cloth collision shove the
bodice and split its seam. You cannot win this with the arm as a capsule bolted
onto a smooth torso. **You need to carve the torso so the arm can sit at the
armhole without the surface fighting** — the armhole socket.

---

## 3. The fix — armhole socket (recommended approach)

Two coupled changes, both in the **dress-form / collision layer** (garment-only;
print spine stays untouched; preview is read-only of the doc):

### 3a. Carve a socket into the torso SDF at each armhole (`body-form.js`)

The torso collision is an analytic SDF (`signedDistTorso` / `insideTorso` /
`torsoSurface`, lofted elliptical rings with per-ring centers `cx,cz` and
semi-axes `a,b`). Add a **socket primitive** subtracted from the torso solid at
the shoulder/armpit on each side, so the surface is *recessed* where the arm
joins:

```
signedDist_with_socket(p) = max( signedDistTorso(p), -signedDistSocket(p) )   // boolean SUBTRACT
insideForm                = insideTorso(p) && !insideSocket(p)   // ... ∪ arms (unchanged)
```

- The socket is a primitive (sphere or short capsule) centered on the **armhole
  center** (≈ the anatomical scye), sized to the armhole opening, axis along the
  arm. Carving it means the arm root can sit *at the armhole* (inboard) without
  the torso surface poking out through the arm or shoving cloth.
- Gate it on arms (`if (stack.arms)`), so the **no-arms / sleeveless / bag form is
  byte-identical** (early-return torso-only path stays).
- Keep render + collision sharing one stack (`group.userData.stack`); the socket
  params ride on the stack so `nearestSurface`/`insideForm` and the renderer agree.

### 3b. Make the arm emerge FROM the armhole, not a fixed formula

This is the real key. Today `buildArms` places the arm from body measurements
alone, so it can't know where the bodice armhole wrapped. To make the cap close,
the **arm root ring must coincide with the bodice armhole**. Two ways:

- **(preferred) Derive the arm from the armhole in `placeGarment`.** `placeGarment`
  already computes the bodice armhole 3D ring (the `armOf(capEdge)` helper returns
  the shoulder `S` and underarm `U` for each cap edge — `pattern-cloth.js` ~183).
  Build/relocate the arm so `p0` = armhole center and `dir` = (armhole outward
  normal, tilted down) — then pass that arm into the wrap **and** the renderer.
  The arm becomes a function of the armhole, so they can't drift. (Render path:
  `preview.js`/`preview3d.js` would need the same armhole-derived arm; simplest is
  to compute the arm in one shared pure helper given `(body, armholeRing)` and call
  it from both the solver and `dressFormGroup`.)
- **(simpler, maybe enough) Reposition the existing capsule arm inboard INTO the
  socket** and re-tune `socketOut/socketDrop/downDeg` so `p0` lands at the armhole.
  With 3a's recess, the inboard arm no longer punches the torso, so the bodice
  shouldn't open this time. Re-run the §2 "move arm inboard" sweep *with the socket
  carved* and find the window that was previously blocked by penetration.

Either way the **acceptance test** is: cap-shoulder gap < ~20 mm, bodice seams
still 0 mm, body penetration still ≲16 mm, wrap coverage still >300°, mirror-
symmetric.

### 3c. Render the socket (optional polish)

`dressFormGeometry` is a tessellated torso mesh (torso-only today). A carved
socket won't show unless the mesh reflects it. Options: (i) leave the render
smooth and accept the collision-only socket (the arm mesh covers the area anyway),
or (ii) push the torso ring vertices inward near the armhole to dimple the mesh.
Start with (i); only do (ii) if the owner sees the arm root poking the smooth
torso.

---

## 4. Files & exact hooks

**`app/static/js/body-form.js`** (the dress form; `window.BodyForm`, pure, no
three/DOM/RNG):
- `ARM` constants — line **34** (`bicepFromBust .32`, `wristFromBicep .58`,
  `lenFrac .42`, `downDeg 12`, `socketOut .85`, `socketDrop .02`, `sleeveEase`,
  `rMin/rMaxFrac`). All `[GATE]`.
- `loft(body, opts)` — line **105**; appends `out.arms = buildArms(...)` **only**
  when `opts.arms` (line ~127). Add `out.sockets` here too (gated the same way).
- `buildArms(b, bands, override)` — line **134**; `override` merges into `ARM`
  (so `opts.arm = {socketOut, downDeg, …}` flows through `loft(body,{arms:true,
  arm:override})`). This is where 3b-simple repositioning lives.
- Capsule collision — `capsuleFoot`/`signedDistCapsule`/`insideCapsule`/
  `capsuleSurface` lines **156–195**.
- Union dispatch — `insideTorso`/`torsoSurface`/`signedDistTorso` (private,
  verbatim originals) wrapped by public `insideForm` (**217**), `nearestSurface`,
  `signedDist`. **This is where 3a's socket subtraction goes** — the public
  dispatchers, behind `if (stack.arms)` so no-arms stays byte-identical.

**`app/static/js/pattern-cloth.js`** (the XPBD drape; `window.PatternCloth`):
- `SIM_VERSION` — line **32** (currently **9**). **Bump to 10** so the cached
  drapes re-settle (the cache is keyed by `geomHash` which folds in SIM_VERSION;
  arm/socket tuning constants are NOT individually hashed, so a behavior change
  needs the bump — this bit us mid-session).
- `hasSleevePiece(pieces)` — line **98**; the single predicate gating arms.
- `placeGarment(...)` sleeve branch — lines **~199–245**: `armOf(capEdge)` returns
  the bodice armhole `S`/`U` (the armhole ring source for 3b); the **mirror-safe
  tube wrap** (`eTop` = world-up ⟂ axis, `eSide` forced +z so L/R wrap identically
  — do NOT reintroduce a `dir×up` frame, it flips handedness and twists the left
  sleeve); the gradual `BLEND` (= `by.H`) cap→arm transition; `armTether`.
- Arm-hug tether build — lines **~447–468**: `armRest`/`armHug`, cap-seam **edge**
  excluded (stays free to weld), `armHugProject()` called in `substep` (line
  ~600) when `armHugOn && nArmHug`; `armHugOn` set true after `pinNow` (~722).
- Solver loft with arms — `solveDrape` ~ line **293**: `form = BF.loft(body,
  wantArms ? {arms:true, arm:opts.arm} : undefined)`. (If 3b-preferred, this is
  where the armhole-derived arm gets injected instead.)
- `bodyProject()` (one-sided collision) — line **~482**; cap-attach (anchors the
  bodice armhole, eases the cap weld) — line **~727**.
- Tunable opts already wired: `opts.armBlend`, `opts.armHugCap`, `opts.arm`
  (override for buildArms). Add `opts.socket*` similarly for fast sweeping.

**`app/static/js/preview3d.js`**: `armCapsuleGeometry(arm, opts)` + the arm loop
in `dressFormGroup` (`userData.kind === 'dressform-arm'`). `dressFormGeometry`
stays torso-only. If you carve the mesh (3c) or armhole-derive the arm (3b), the
render arm must match the collider arm — they already share `stack`.

**`app/static/js/preview.js`**: `dressFormGroup(params.body, { arms:
PC.hasSleevePiece(params.pieces) })` (~line 146). `solveOpts()` leaves `arms`
unset so the solver derives it.

---

## 5. Invariants (do not break)

1. **Print spine + calibration gate byte-identical** — never touch
   `pattern-pdf.js`/`printing.py`/`pattern-geom.js`/`pattern-fold.js`/
   `pattern-mesh.js`/`main.py`/`models.py`/`db.py`. Preview is read-only of the doc.
2. **No-arms paths byte-identical** — sockets/arms exist *only* when
   `opts.arms`/`stack.arms`/`stack.sockets` present; the public collision
   dispatchers must early-return the torso-only result when absent. Bags + every
   sleeveless garment (skirt/dress/plain bodice) must re-solve byte-identical
   (only the SIM_VERSION bump re-keys their cache once). Guarded by
   `verify-cloth.mjs` (bag sentinel) + the sleeveless tests in
   `verify-garment-drape.mjs`.
3. **Renderer and collider can't drift** — arm/socket are a pure function of
   `(body[, armholeRing])`, computed once and shared via `group.userData.stack`.
4. **SIM_VERSION bump** on any behavior change (cache invalidation).
5. **Owner-gate workflow** (`sewing-owner-gate-workflow` memory): the owner
   verifies on her 1920×1080 touchscreen Fedora laptop before commit; deploy via
   `podman build -t sewingapp . && systemctl --user restart sewingapp`; smoke-test
   **inside** the container (`podman exec sewingapp python3 -c "import
   urllib.request; ..."`), NOT localhost curl. Commit **directly to main**
   (`sewing-commit-to-main` memory) — no PRs.

---

## 6. Tests to extend

- `tools/preview/verify-body-form.mjs` (52 asserts): add socket coverage —
  a point at the armhole center is now OUTSIDE the form (carved), the no-arms form
  is byte-identical, render shares the socketed stack.
- `tools/preview/verify-garment-drape.mjs` (61 asserts): the sleeve block already
  has the **true wrap-coverage** assertion (>270°, top+bottom) and bodice-closed /
  penetration / symmetry. **Add the acceptance gate: cap-shoulder gap < ~20 mm**
  (measure cap-seam pairs with mid-y > 1320, like the deployed
  `(Stage B2: cap↔armhole gap …)` log line — currently reports ~85). That single
  number is the definition of done for this session.
- `tools/preview/verify-cloth.mjs` (26): bag byte-identity sentinel — must stay 0
  diff.
- Run the whole suite: `cd tools && for d in preview tiling; do for f in
  $d/verify-*.mjs; do (cd $d && node $(basename $f)); done; done`.

---

## 7. Reproduce / measure (headless, ~1 s each)

The session scratchpad scripts are gone, but they're trivial to recreate. The
harness: eval the modules into a fake `window`, build the tank fixture (front/back
bodice + two drafted sleeves via `G.draftSleeve` + `G.bodiceArmholes` +
`G.matchedBackArmhole`), `Cl.solveDrape(pieces, seams, {h:20, garment:true, body})`,
then read `rs.nodes` / `rs.seamLinks` / `rs.pieceRanges`. The seeded **id 7 / id 8**
docs are the real targets (dump them via `podman exec sewingapp python3` reading
the SQLite, or rebuild from `tools/seed-examples.mjs` `sleevedTank()`).

Key metrics to print each run:
- **cap-shoulder gap** = max over cap-seam pairs (one side sleeve, one side bodice)
  with mid-y > 1320, of the pair distance. **Target < 20.** (Today ~85.)
- **bodice gap** = max over bodice-only seam pairs. Must stay < 15.
- **penetration** = `max(0, -min(0, BF.signedDist(form, node)))` over all nodes
  (loft the form WITH arms+sockets). Keep ≲16.
- **wrap coverage** = angular span of mid-sleeve nodes around the arm axis in the
  (`eTop`, `eSide`-forced-+z) frame. Keep > 300, top & bottom both present.
- **symmetry** = |x̄_R + x̄_L|, |z̄_R − z̄_L| over the two sleeve centroids. Keep small.

---

## 8. If 3b proves hard

The honest fallback hierarchy, best→acceptable:
1. Armhole-derived arm + socket (§3a+3b-preferred) — cap closes, production-worthy.
2. Socket + inboard capsule arm (§3a+3b-simple) — likely closes most of it.
3. Socket only, cap accepts a small residual — better than today, ship if owner ok.
4. Status quo (committed `3a1d9c8`) — wrap is great, ~85 mm shoulder gap.

Don't chase the gap with pure solver tricks again — §2 shows that's a dead end.

---

*Memory pointers:* `sewing-sleeve-arms-insight`, `sewing-owner-gate-workflow`,
`sewing-commit-to-main`. The prior B1 deep-dive is `HANDOFF-sleeve-3d.md` (cap-gap
history) — this socket work supersedes its "OPEN PROBLEM" section. The B2 plan
that produced the arms is `~/.claude/plans/your-handoff-is-handoff-sleeve-3d-md-
replicated-shamir.md`.
