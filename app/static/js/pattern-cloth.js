// pattern-cloth.js — XPBD mass-spring cloth solver (Step 3a / milestone M4).
//
// Pure, headless, three-free (mirrors pattern-fold.js / pattern-mesh.js): a classic IIFE
// attaching `window.PatternCloth` so the Node test tools/preview/verify-cloth.mjs can `eval`
// it with a plain `window` shim, and the browser preview can read the global. Depends on
// `window.PatternFold` (the rigid fold — the WARM START), `window.PatternMesh`
// (triangulation + seam pairing), and transitively `window.poly2tri` + `window.PatternGeom`.
// NO three.js, NO DOM — three meets the cloth only in preview3d.js (Phase 2).
//
// What it does: takes a freeform bag's flat `pieces` + `seams`, sews the panels together
// with zero-rest seam springs, and inflates them into a soft, rounded 3D bag.
//   1. Warm start  — place each non-strap piece's sim mesh at its folded {pos,quat}, so the
//      seam endpoints begin CLOSE (this is why M3 exists; good placement is ~80% of stability).
//   2. Stitch-up   — gravity + pressure OFF; structural + seam springs only, seam stiffness
//      eased soft→stiff, many tiny substeps, per-substep node-move clamped to ≈0.5·h (the
//      single most important explosion guard). Panels float together along the seams.
//   3. Inflate     — per-face outward-normal "puffiness" pressure (open-top safe — a tote is
//      NOT a closed surface, so an enclosed-volume constraint is ill-defined), eased in,
//      balanced by the near-rigid stretch constraints → a gently rounded bag.
//   4. Settle      — run until motion falls below a threshold; freeze + return the mesh.
//
// World convention (matches pattern-fold.js / preview3d.js): y-up millimetres, base on the
// floor (y=0). A piece's local point (x,y) embeds as (x,y,0) → world = pos + quat·(x,y,0).
//
// Determinism: NO Math.random / Date.now; fixed iteration order; the only early-exit is a
// deterministic motion threshold. Same input → reproducible output (the headless test relies
// on this). Straps stay OUT of the sim (foldDoc excludes them; rendered as arched handles).

(function () {
  "use strict";

  const SIM_VERSION = 10;  // 10: bodice assembles over real SHOULDERS+neck — fold-direction untwist for bodice↔bodice
                           //     seams (gated; skirt/cap unaffected) + over-the-shoulder ridge drape (neckline corners
                           //     left unpinned) + honest per-seam straggler snap → the shoulder seam closes on a real
                           //     surface (girth misfit still gaps+warns on the side seams). Form gains a neck band.
                           // 9: sleeve cap de-crumpled — GRADUAL armhole→arm blend over the whole sleeve (a short
                           //    blend forced a horizontal arm-ring under the shoulder, where the armhole is a vertical
                           //    slit → it buckled) + the cap INTERIOR tethers smooth (cap EDGE stays free to weld)
                           // 8: sleeve WRAPS the arm — mirror-safe tube warm-start (eSide forced +z, no handedness
                           //    flip) + an arm-hug tether confining the sleeve body to a shell around the limb so
                           //    gravity can't sag it into a pouch underneath ("doesn't go around the arm")
                           // 7: analytic capsule ARMS on the dress form — sleeve drapes OVER the arm limb (12° arm,
                           //    body collision; an arm-wrap warm-start was tried + dropped — it twisted the left sleeve)
                           // 6: arms (intermediate, superseded by 7) — note: arm tuning constants aren't in geomHash,
                           //    so a behavior change in them needs a SIM_VERSION bump to invalidate cached drapes
                           // 5: set-in SLEEVE drape (placeGarment sleeve wrap + underarm non-dart self-seam spring)
                           // 4: cloth self-collision (final-settle node repulsion) + garment seam-closeup (free-hem zip)
                           // 3: garment unpinned stitch-up + bounded stretch-to-fit + strain metric
                           // 2: garment gravity drape + dart welds (invalidates pre-dart cached drapes)

  // ── tiny 3D vec / quaternion helpers (copied from pattern-fold.js; standalone) ──────
  const EPS = 1e-9;
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function quatRotateVec(q, v) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
      v[0] + w * tx + (y * tz - z * ty),
      v[1] + w * ty + (z * tx - x * tz),
      v[2] + w * tz + (x * ty - y * tx),
    ];
  }
  const applyT = (T, v) => add(T.pos, quatRotateVec(T.quat, v));
  const nodeXY = (p, i) => { const n = p.nodes[i % p.nodes.length]; return [n.x, n.y, 0]; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (s) => { s = s < 0 ? 0 : s > 1 ? 1 : s; return s * s * (3 - 2 * s); };
  const triArea2D = (a, b, c) =>
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;

  const PF = () => (typeof window !== "undefined" && window.PatternFold) || null;
  const PM = () => (typeof window !== "undefined" && window.PatternMesh) || null;
  const PG = () => (typeof window !== "undefined" && window.PatternGeom) || null;

  // Defaults — all overridable via opts (so the owner-gate tuning loop needs no code edit).
  const DEFAULTS = {
    h: 20,                 // node spacing (mm): Draft 25 / Standard 20 / Fine 15
    pressure: 0.08,        // per-substep outward "puffiness" nudge (mm-ish); 0 disables inflation
    inflateCap: 0.05,      // tether: max node drift from the stitched shape, as a fraction of the
                           //   bag diagonal — bounds the puff so it ROUNDS, never balloons (robust
                           //   to pressure: above the buckling threshold the cap, not P, sets shape)
    maxStitch: 48,         // zero-gravity stitch-up substeps (handoff 30–60); 0 = skip
    maxSettle: 220,        // settle substep cap; 0 = skip
    stitchIters: 1,        // constraint iterations per stitch substep (handoff ~1)
    settleIters: 4,        // constraint iterations per settle substep
    damp: 0.06,            // global velocity damping per substep
    compliance: { stretch: 1e-8, bend: 2e-2, seam0: 1e-1, seam1: 1e-6 },
  };

  // Fabric presets (M5c garments): bend compliance is the dominant visual lever (denim low →
  // few large folds; silk high → many small folds); mass scales the lumped node mass (heavier
  // → resists deformation, holds folds). Stretch stays near-rigid (wovens barely stretch).
  const FABRICS = {
    cotton: { stretch: 1e-8, bend: 8e-3, mass: 1.0 },
    denim:  { stretch: 5e-9, bend: 2e-3, mass: 2.2 },
    silk:   { stretch: 2e-8, bend: 4e-2, mass: 0.5 },
    linen:  { stretch: 1e-8, bend: 1.4e-2, mass: 1.2 },
  };
  const G_MM = 9810;   // gravity, mm/s²

  const isStrap = (p, seams) => (PF() && PF().isStrapPiece) ? PF().isStrapPiece(p, seams) : false;
  // A garment with any sleeve piece gets analytic arms on the dress form (Stage B2). SINGLE
  // source of truth: solveDrape (collider loft) + preview.js (render loft) both gate on this,
  // so the visible form and the collider can't drift.
  const hasSleevePiece = (pieces) => (pieces || []).some((p) => p && p.place3d && p.place3d.role === "sleeve");
  function pieceBBoxY(nodes) { let lo = Infinity, hi = -Infinity; for (const n of nodes) { if (n.y < lo) lo = n.y; if (n.y > hi) hi = n.y; } return { lo, hi, H: Math.max(1, hi - lo) }; }
  function pieceBBoxX(nodes) { let lo = Infinity, hi = -Infinity; for (const n of nodes) { if (n.x < lo) lo = n.x; if (n.x > hi) hi = n.x; } return { lo, hi, W: Math.max(1, hi - lo) }; }
  function inferRole(p, idx) {
    const n = (p.name || "").toLowerCase();
    const skirt = /skirt/.test(n), back = /back/.test(n), base = back ? "back" : "front";
    if (skirt) return base + "-skirt";
    if (/front|back/.test(n)) return base;
    return idx % 2 ? "back" : "front";
  }

  // Warm start for GARMENTS: wrap each flat panel around the dress form — map it onto an arc of
  // the form's ellipse at its band height (front panel → front half, skirt → hangs from the
  // waist), pushed just OUTSIDE the surface, so seam endpoints start close + outside the body
  // (placement is ~80% of stitch-up stability). Returns per-piece { wrap(lx,ly)→[x,y,z],
  // pinTest(lx,ly)→bool } — pinTest marks the top edge (shoulders/waistband) held during drape.
  // Degrade-never-blank: with no form/role it lays panels flat in front of where the form is.
  function placeGarment(pieces, seams, form, ringAt, opts) {
    const DEG = Math.PI / 180, skin = (opts && opts.skin) || 8, gap = (opts && opts.wrapGap) || 20;
    const bandY = {}; for (const bd of form.bands) bandY[bd.role] = bd.y;
    const shoulderY = bandY.shoulder, waistY = bandY.waist;
    // M6/bodice assembly: the form now has a NECK band above the shoulder (body-form.js), so the
    // bodice TOP can drape over a real shoulder SURFACE instead of a flat ring — which is what lets
    // the (now untwisted, fold-flip) shoulder seam close HONESTLY. SHZ = the top fraction of the
    // bodice that climbs the shoulder ridge; vSh = where the body zone ends and the climb begins.
    const neckY = bandY.neck, hasNeck = neckY != null;
    const SHZ = (opts && opts.shoulderZone) || 0.25;
    const vSh = 1 - SHZ;
    const ridgeSpanDeg = (opts && opts.ridgeSpanDeg) || 70;
    // front/back sectors MEET at the sides (±90°) so a front↔back side seam's endpoints start
    // coincident on the body's widest point (a small warm-start gap there never closes against the body).
    const FRONT = [-90 * DEG, 90 * DEG], BACK = [90 * DEG, 270 * DEG], SIDE_R = [40 * DEG, 140 * DEG], SIDE_L = [220 * DEG, 320 * DEG];
    const place = {};
    const byId = {}; for (const p of pieces) byId[p.id] = p;
    const sleeves = [];
    pieces.forEach((p, idx) => {
      const nm = (p.name || "").toLowerCase();
      const role = (p.place3d && p.place3d.role) || inferRole(p, idx);
      // straps + finishing strips (waistband/binding/facing) are not draping panels — but a SLEEVE is
      // one, so the strap/long-&-thin guard must NOT skip it (a long sleeve can read as long-&-thin).
      if (role !== "sleeve" && (isStrap(p, seams) || /waistband|binding|facing|band/.test(nm))) return;
      const nodes = p.nodes || []; if (!nodes.length) return;
      const bx = pieceBBoxX(nodes), by = pieceBBoxY(nodes);
      if (role === "sleeve") { sleeves.push({ p, nm, bx, by }); return; }   // PASS 2 (needs the bodice wraps)
      // skirt/back can come from the role OR the piece name (robust to hand-authored naming).
      const isBack = /back/.test(role) || (!/front/.test(role) && /back/.test(nm));
      const isSkirt = /skirt/.test(role) || /skirt/.test(nm);
      let sector = isBack ? BACK : FRONT;
      if (/side/.test(role)) sector = /left|_l|-l/.test(role) ? SIDE_L : SIDE_R;
      const yHi = isSkirt ? waistY : shoulderY;
      const yLo = isSkirt ? waistY - by.H : waistY;        // skirt hangs from the waist by its own height
      // The z=0 shoulder RIDGE: a curve on the form surface from the acromion (shoulder band, at the
      // side th≈±90°) sloping IN and UP to the side-base-of-neck (neck band) as th moves toward the
      // front/back centre. BOTH front and back drape their shoulder edge onto THIS shared ridge — so
      // the crossed shoulder seam closes over a REAL surface (front +z & back −z both pulled to z=0)
      // instead of twisting the armhole or springing the neckline open. Symmetric in sigma (±x side)
      // and phi (angular distance from the side plane), so corresponding front/back seam nodes map to
      // the SAME ridge point → they coincide for a fitting garment.
      const ridgeAt = (th) => {
        const sigma = Math.sin(th) >= 0 ? 1 : -1;                        // +x (R) / −x (L) shoulder
        const rS = ringAt(shoulderY), rN = ringAt(neckY);
        const phi = Math.abs(th - sigma * (Math.PI / 2));                // angular dist from the side plane
        const t = Math.min(1, phi / (ridgeSpanDeg * DEG));              // 0 = acromion … 1 = side-neck
        return [sigma * lerp(rS.a + skin, rN.a + skin, t), lerp(shoulderY, neckY, t), 0];
      };
      const wrap = (lx, ly) => {
        const u = (lx - bx.lo) / bx.W, v = (ly - by.lo) / by.H;
        const th = sector[0] + u * (sector[1] - sector[0]);
        const wy = yLo + v * (yHi - yLo);
        const r = ringAt(wy);
        const base = [(r.a + skin + gap) * Math.sin(th), wy, (r.b + skin + gap) * Math.cos(th)];
        if (isSkirt || !hasNeck || v <= vSh) return base;                // body zone = old wrap (byte-identical)
        const Rdg = ridgeAt(th);
        // Climb FULLY to the ridge so the shoulder seam closes over a real surface. The shoulder seam always
        // sews (front edge ↔ back edge, equal length) regardless of body size, so closing it is correct —
        // it's the GIRTH that can fail to reach around, which gaps honestly on the SIDE seams.
        const sv = smoothstep((v - vSh) / (1 - vSh));
        return [base[0] + sv * (Rdg[0] - base[0]),
                base[1] + sv * (Rdg[1] - base[1]),
                base[2] + sv * (Rdg[2] - base[2])];
      };
      // A skirt hangs from its waist (top pinned, hem free). A bodice is FITTED shoulder-to-waist:
      // anchor the waist too so it doesn't droop to the wider hip (which would split the side seam) —
      // but leave any waist-dart MOUTH unpinned so the dart still sews shut (pinning the whole waist
      // would hold the dart open). Compute each wedge dart's mouth u-range from its edge geometry.
      const dartFreeU = [];
      for (const d of (p.darts || [])) {
        if (d.kind !== "wedge") continue;
        const e = d.edge | 0, a = nodes[e], b = nodes[(e + 1) % nodes.length];
        const elen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const hw = Math.min(0.5, (d.width / 2) / elen + 0.04);          // half mouth in edge-fraction + margin
        const x0 = a.x + Math.max(0, d.center - hw) * (b.x - a.x), x1 = a.x + Math.min(1, d.center + hw) * (b.x - a.x);
        dartFreeU.push([(Math.min(x0, x1) - bx.lo) / bx.W, (Math.max(x0, x1) - bx.lo) / bx.W]);
      }
      // The NECKLINE is the FREE top edge(s) (not in any seam). Its corner nodes are shoulder-seam
      // endpoints that the free neckline pulls toward each panel — so DON'T pin them (pinning freezes
      // that gap; left free, the hardened seam closeup pulls the front+back corners together). Pin only
      // the SEWN shoulder line (it drapes over the shoulder ridge + supports the bodice). Derive the
      // neckline u-span from the seams so it's robust for hand-drawn bodices, not a hard-coded range.
      const sewnEdge = new Set();
      for (const s of (seams || [])) { if (s.a.piece === p.id) sewnEdge.add(s.a.edge); if (s.b.piece === p.id) sewnEdge.add(s.b.edge); }
      const freeTopU = [];
      for (let e = 0; e < nodes.length; e++) {
        if (sewnEdge.has(e)) continue;
        const na = nodes[e], nb = nodes[(e + 1) % nodes.length];
        if ((na.y - by.lo) / by.H < 0.85 || (nb.y - by.lo) / by.H < 0.85) continue;   // a TOP free edge
        const ua = (na.x - bx.lo) / bx.W, ub = (nb.x - bx.lo) / bx.W;
        freeTopU.push([Math.min(ua, ub), Math.max(ua, ub)]);
      }
      const pinTest = isSkirt
        ? (lx, ly) => (ly - by.lo) / by.H >= 0.92
        : (lx, ly) => {
            const v = (ly - by.lo) / by.H;
            const u = (lx - bx.lo) / bx.W;
            if (v >= 0.92) return !freeTopU.some(([a, b]) => u >= a && u <= b);  // pin shoulder line, NOT the free neckline
            return v <= 0.08 && !dartFreeU.some(([a, b]) => u >= a && u <= b);   // waist, except a dart mouth
          };
      place[p.id] = { wrap, pinTest, role };
    });

    // ── PASS 2: SLEEVES, anchored onto their armholes (now that the bodice wraps exist) ──
    // A naïve "tube beside the torso" warm start starts the cap seam ~50 mm off the armhole, and the
    // stitch-up then DRAGS the bodice armhole outward → the bodice's own side seam splits open. Instead
    // map the sleeve's cap SEAMLINE directly onto the bodice armhole: the 3 cap landmarks (underarm-R =
    // node 2 → BACK-armhole underarm; cap-top = node 3 → shoulder; underarm-L = node 4 → FRONT-armhole
    // underarm) ride the wrapped bodice armhole, and the body of the sleeve hangs straight down (leaning
    // out so it clears the wider waist/hip). The cap seam then starts ~0 → no bodice disruption.
    const og = skin + gap;
    const lerp3 = (A, B, t) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    for (const { p, nm, bx, by } of sleeves) {
      // the 3D shoulder/underarm of the bodice armhole a sleeve cap edge sews to (via the bodice wrap).
      const armOf = (capEdge) => {
        for (const s of seams) {
          let other = null, oe = null;
          if (s.a.piece === p.id && s.a.edge === capEdge) { other = s.b.piece; oe = s.b.edge; }
          else if (s.b.piece === p.id && s.b.edge === capEdge) { other = s.a.piece; oe = s.a.edge; }
          if (other && place[other] && byId[other]) {
            const bp = byId[other], n = bp.nodes.length, a = bp.nodes[oe], b = bp.nodes[(oe + 1) % n];
            const sh = a.y >= b.y ? a : b, un = a.y >= b.y ? b : a;     // shoulder = higher local y
            return { S: place[other].wrap(sh.x, sh.y), U: place[other].wrap(un.x, un.y) };
          }
        }
        return null;
      };
      const fr = armOf(3), bk = armOf(2);                              // e3 = front cap, e2 = back cap
      const arm = (form.arms || []).find((a) => a.side === (/left|_l|-l/.test(nm) ? "L" : "R"));
      // Stage B2: WRAP the sleeve as a TUBE around the arm so it goes ALL the way around the limb (the
      // underarm self-seam closes underneath) instead of hanging as a flat flap over the outer side (the
      // owner's "doesn't go around the arm"). The frame is built from WORLD axes — eTop = world-up
      // projected ⟂ the arm axis (the outer/top of the arm), eSide forced toward +z (FRONT) for BOTH
      // sleeves — so the left and right wrap the SAME way. (The earlier attempt used dir×up, whose
      // handedness flips between mirrored arms → it twisted the left sleeve. Forcing eSide·(+z)>0 kills
      // that flip.) Each flat node maps u→θ around the tube (u=½ cap-top→top θ=0; u=0/1 underarm→±π,
      // underneath) and its depth-below-the-cap-seamline → distance DOWN the arm axis.
      let wrap, armTether = null;
      if (arm) {
        const aLen = Math.hypot(arm.p1[0] - arm.p0[0], arm.p1[1] - arm.p0[1], arm.p1[2] - arm.p0[2]) || 1;
        const dir = [(arm.p1[0] - arm.p0[0]) / aLen, (arm.p1[1] - arm.p0[1]) / aLen, (arm.p1[2] - arm.p0[2]) / aLen];
        const upd = dir[1];                                            // up·dir (up = (0,1,0))
        let eTop = [-upd * dir[0], 1 - upd * dir[1], -upd * dir[2]];   // world-up ⟂ axis → outer/top of the arm
        const etn = Math.hypot(eTop[0], eTop[1], eTop[2]) || 1; eTop = [eTop[0] / etn, eTop[1] / etn, eTop[2] / etn];
        let eSide = [dir[1] * eTop[2] - dir[2] * eTop[1], dir[2] * eTop[0] - dir[0] * eTop[2], dir[0] * eTop[1] - dir[1] * eTop[0]];
        if (eSide[2] < 0) eSide = [-eSide[0], -eSide[1], -eSide[2]];   // FORCE +z (front) → mirror-symmetric wrap
        const underLocal = (p.nodes[2] && p.nodes[2].y) || by.H * 0.5, top = by.H;
        const SNUG = skin + 4;                                         // hug the arm closely (a loose wrap sags off the thin limb)
        const depthOf = (lx, ly) => {
          const u = (lx - bx.lo) / bx.W;
          const capY = underLocal + (top - underLocal) * (1 - Math.abs(2 * u - 1));   // cap seamline height (peak at cap-top)
          return Math.max(0, capY - (ly - by.lo));                    // mm below the cap seamline
        };
        const armWrapAt = (lx, ly) => {                               // the tube wrap on the arm
          const u = (lx - bx.lo) / bx.W;
          const th = (0.5 - u) * 2 * Math.PI;                         // u=½ → 0 (cap-top, on top); u=0/1 → ±π (underarm, underneath)
          const depth = depthOf(lx, ly), t = Math.min(1, depth / aLen);
          const R = (arm.r0 + (arm.r1 - arm.r0) * t) + SNUG;          // arm radius at t + a small clearance
          const cx = arm.p0[0] + dir[0] * depth, cy = arm.p0[1] + dir[1] * depth, cz = arm.p0[2] + dir[2] * depth;
          const c = Math.cos(th), s = Math.sin(th);
          return [cx + R * (c * eTop[0] + s * eSide[0]), cy + R * (c * eTop[1] + s * eSide[1]), cz + R * (c * eTop[2] + s * eSide[2])];
        };
        // CAP EDGE rides the bodice armhole arch (a tall vertical slit on the torso side) so the cap seam
        // CLOSES; the BODY wraps the arm. Blend between them over the first BLEND mm below the cap seamline
        // — the armhole and the arm don't co-locate (the arm is bolted on OUTBOARD of the armhole to clear
        // the torso), so without this the body-on-arm tether drags the cap edge ~100 mm off the armhole.
        let archAt = null;
        if (fr && bk) {
          const S = lerp3(fr.S, bk.S, 0.5), frontUnder = fr.U, backUnder = bk.U;
          const arch = (pp) => pp <= 0.5 ? lerp3(backUnder, S, pp / 0.5) : lerp3(S, frontUnder, (pp - 0.5) / 0.5);
          archAt = (u) => arch(1 - u);                                // u=1 back-under … ½ shoulder … 0 front-under
        }
        const BLEND = (opts && opts.armBlend) || by.H;                // transition cap(on armhole)→body(on arm) over ~the whole sleeve: a SHORT blend forces a horizontal arm-ring right under the shoulder (the armhole is a vertical slit) → it buckles
        wrap = (lx, ly) => {
          const armPt = armWrapAt(lx, ly);
          if (!archAt) return armPt;
          const b = smoothstep(Math.min(1, depthOf(lx, ly) / BLEND)), ap = archAt((lx - bx.lo) / bx.W);
          return [ap[0] + (armPt[0] - ap[0]) * b, ap[1] + (armPt[1] - ap[1]) * b, ap[2] + (armPt[2] - ap[2]) * b];
        };
        // Tether the sleeve to its smooth warm-start so gravity can't peel the body off the thin arm into a
        // pouch (the "doesn't go around"), AND so the cap region can't buckle into a crumpled tangle at the
        // shoulder (the "top gets messy"): the warm-start already puts the cap EDGE on the armhole (blend=0)
        // and the body on the arm, so holding that smooth shape keeps the join clean. Mirror-symmetric.
        const TETH = (opts && opts.armTetherDepth != null) ? opts.armTetherDepth : 0;
        armTether = (lx, ly) => (depthOf(lx, ly) >= TETH ? wrap(lx, ly) : null);
      } else if (fr && bk) {
        const S = lerp3(fr.S, bk.S, 0.5), frontUnder = fr.U, backUnder = bk.U;
        const hyp = Math.hypot(S[0], S[2]) || 1, outward = [S[0] / hyp, 0, S[2] / hyp];   // away from the Y axis
        const underLocal = (p.nodes[2] && p.nodes[2].y) || by.H * 0.5, top = by.H;
        const arch = (pp) => pp <= 0.5 ? lerp3(backUnder, S, pp / 0.5) : lerp3(S, frontUnder, (pp - 0.5) / 0.5);
        wrap = (lx, ly) => {
          const u = (lx - bx.lo) / bx.W;                               // u: 1 = node2 (back-under) … 0 = node4 (front-under)
          const base = arch(1 - u);                                    // ride the armhole arch (pp = 1−u)
          const capY = underLocal + (top - underLocal) * (1 - Math.abs(2 * u - 1));   // local arch height (peak at cap-top)
          const depth = Math.max(0, capY - (ly - by.lo));              // mm below the cap seamline → hang down
          return [base[0] + outward[0] * (og + 0.22 * depth), base[1] - depth, base[2] + outward[2] * (og + 0.22 * depth)];
        };
      } else {
        // fallback (no armhole seams found): a tube hanging beside the torso at the shoulder band.
        const sign = /left|_l|-l/.test(nm) ? -1 : 1, rTube = Math.max(20, bx.W / (2 * Math.PI));
        const cxArm = sign * (ringAt(shoulderY).a + rTube + gap), yBase = shoulderY - by.H;
        wrap = (lx, ly) => { const th = ((lx - bx.lo) / bx.W) * 2 * Math.PI;
          return [cxArm + sign * rTube * Math.cos(th), yBase + (ly - by.lo), rTube * Math.sin(th)]; };
      }
      place[p.id] = { wrap, pinTest: () => false, role: "sleeve", armTether };
    }
    return { place };
  }

  // Sew direction for a garment seam, from the WRAPPED warm-start positions (the garment warm
  // start has no rigid transform — mirror deriveFlip using wrap() of the edge endpoints).
  function deriveFlipWrapped(gpA, A, ea, gpB, B, eb) {
    if (!gpA || !gpB) return false;
    const nA = A.nodes.length, nB = B.nodes.length;
    const A0 = gpA.wrap(A.nodes[ea].x, A.nodes[ea].y), A1 = gpA.wrap(A.nodes[(ea + 1) % nA].x, A.nodes[(ea + 1) % nA].y);
    const B0 = gpB.wrap(B.nodes[eb].x, B.nodes[eb].y), B1 = gpB.wrap(B.nodes[(eb + 1) % nB].x, B.nodes[(eb + 1) % nB].y);
    const ht = Math.max(dist3(A0, B1), dist3(A1, B0)), hh = Math.max(dist3(A0, B0), dist3(A1, B1));
    return hh < ht;
  }

  // ── the solver ──────────────────────────────────────────────────────────────────────
  function solveDrape(pieces, seams, opts) {
    opts = opts || {};
    const h = opts.h > 0 ? opts.h : DEFAULTS.h;
    const garment = !!(opts.garment || opts.body);     // garment → gravity drape on a dress form
    const fab = garment ? (FABRICS[opts.fabric] || FABRICS.cotton) : null;
    const C = Object.assign({}, DEFAULTS.compliance, fab ? { stretch: fab.stretch, bend: fab.bend } : {}, opts.compliance || {});
    const massScale = fab ? fab.mass : 1;
    const pressure = opts.pressure != null ? opts.pressure : DEFAULTS.pressure;
    const inflateCap = opts.inflateCap != null ? opts.inflateCap : DEFAULTS.inflateCap;
    const maxStitch = opts.maxStitch != null ? opts.maxStitch : (garment ? 60 : DEFAULTS.maxStitch);
    const maxSettle = opts.maxSettle != null ? opts.maxSettle : (garment ? 360 : DEFAULTS.maxSettle);
    const stitchIters = opts.stitchIters != null ? opts.stitchIters : DEFAULTS.stitchIters;
    const settleIters = opts.settleIters != null ? opts.settleIters : DEFAULTS.settleIters;
    const damp = opts.damp != null ? opts.damp : DEFAULTS.damp;

    // Normalize identically to foldDoc so our piece ids match its transform keys.
    const G = PG();
    if (G && G.normalizePieces) pieces = G.normalizePieces({ pieces: pieces || [] });
    else pieces = (pieces || []).map((p, i) => Object.assign({ id: p.id || "p" + (i + 1) }, p));
    if (G && G.normalizeSeams) seams = G.normalizeSeams(seams || [], pieces);
    else seams = seams || [];

    const fold = (PF() && PF().foldDoc) ? PF().foldDoc(pieces, seams, { root: opts.root || null })
      : { mode: "tree", transforms: {}, straps: [] };
    const transforms = fold.transforms || {};
    const byId = {}; pieces.forEach((p) => { byId[p.id] = p; });

    // GARMENT warm start: loft the dress form + wrap each panel onto it (NOT the rigid fold).
    const BF = (typeof window !== "undefined") && window.BodyForm;
    let form = null, ringAt = null, gplace = null;
    if (garment && BF) {
      // Arms when the doc has a sleeve (or forced via opts.arms — the test's A/B). Same predicate
      // geomHash uses (via the hashed pieces), so cache write/re-solve agree. Bags never reach here.
      const wantArms = opts.arms != null ? !!opts.arms : hasSleevePiece(pieces);
      form = BF.loft(opts.body || BF.DEFAULT_BODY, wantArms ? { arms: true, arm: opts.arm } : undefined);
      ringAt = (y) => BF.ringAt(form, y);
      gplace = placeGarment(pieces, seams, form, ringAt, opts).place;
    }

    // ── assemble: triangulate each NON-strap (placed) piece and lift it into 3D ──
    const pos = [], localUV = [], pieceRanges = [], meshes = {}, pins = [];
    for (const p of pieces) {
      const gp = gplace ? gplace[p.id] : null;
      const T = transforms[p.id];
      // garment with a form → need a wrap; else fall back to the fold transform (degrade: a garment
      // with no BodyForm drapes off the rigid fold under gravity rather than blanking).
      if ((garment && gplace) ? !gp : !T) continue;
      const mesh = PM() && PM().triangulatePiece ? PM().triangulatePiece(p, h) : null;
      if (!mesh || !mesh.nodes.length) continue;
      const start = pos.length;
      for (const nd of mesh.nodes) {
        pos.push(gp ? gp.wrap(nd[0], nd[1]) : applyT(T, [nd[0], nd[1], 0]));
        localUV.push([nd[0], nd[1]]);
        if (gp && gp.pinTest(nd[0], nd[1])) pins.push(pos.length - 1);   // top edge (shoulders/waist) → pinned
      }
      meshes[p.id] = { mesh, start };
      pieceRanges.push({ piece: p.id, start, count: mesh.nodes.length });
    }
    const N = pos.length;
    const empty = { nodes: [], tris: [], pieceRanges: [], localUV: [], seamLinks: [], welds: [], mode: "warm", energy: 0 };
    if (!N) return empty;

    // global triangles + structural constraints (piece-local indices offset by range start)
    const tris = [];
    const sI = [], sJ = [], sR = [];          // stretch (distance)
    const bI = [], bJ = [], bR = [];          // bend (opposite-vertex distance)
    for (const pr of pieceRanges) {
      const m = meshes[pr.piece].mesh, off = pr.start;
      for (const t of m.tris) tris.push([t[0] + off, t[1] + off, t[2] + off]);
      for (const d of m.dist) { sI.push(d[0] + off); sJ.push(d[1] + off); sR.push(d[2]); }
      for (const d of m.bend) { bI.push(d[0] + off); bJ.push(d[1] + off); bR.push(d[2]); }
    }

    // seam constraints (zero rest length). Derive sew DIRECTION per seam from the warm-start
    // geometry (mirror pattern-fold.inferFlip), then pair nodes by arc-length via seamPairs.
    // kI/kJ: STRUCTURAL seams (bodice + the sleeve underarm self-seam) — sewn from the start, in the
    // strain gate. kIc/kJc: EASED cap seams (a sleeve cap into a shorter armhole) — held inert during
    // the unpinned stitch-up and eased in AFTER the bodice pins, else the cap drags the (then-pinned)
    // shoulder open; also NOT in the strain gate (their residual IS the intended ease). welds: darts.
    const seamLinks = [], kI = [], kJ = [], kSeam = [], kIc = [], kJc = [], weldI = [], weldJ = [];
    const isSleeveId = (pid) => { const gp = gplace && gplace[pid]; if (gp && gp.role) return gp.role === "sleeve"; const p = byId[pid]; return !!(p && p.place3d && p.place3d.role === "sleeve"); };
    const isSkirtId = (pid) => { const gp = gplace && gplace[pid]; if (gp && gp.role) return /skirt/.test(gp.role); const p = byId[pid]; return !!(p && (/skirt/.test((p.name || "").toLowerCase()) || (p.place3d && /skirt/.test(p.place3d.role || "")))); };
    for (const s of seams) {
      // A same-piece seam that joins TWO DIFFERENT edges (the sleeve underarm) sews as a normal SPRING
      // via seamPairs below — ma===mb, distinct boundary nodes. Wedge darts are NOT in seams[] (they
      // live in piece.darts[] → welded separately), so the only same-piece seam here is a real one.
      if (s.a.piece === s.b.piece && s.a.edge === s.b.edge) continue;  // degenerate self-seam only
      const ma = meshes[s.a.piece], mb = meshes[s.b.piece];
      if (!ma || !mb) continue;                                       // strap seam, or a dropped piece
      const TA = transforms[s.a.piece], TB = transforms[s.b.piece];
      const A = byId[s.a.piece], B = byId[s.b.piece];
      // A CAP seam (sleeve ↔ bodice, exactly one side a sleeve) is phased + out of the strain gate —
      // keyed on sleeve-involvement, NOT on ease, so even a 0-ease cap (the owner's relaxed style) is
      // held out of the unpinned stitch-up. The underarm self-seam (sleeve↔sleeve) stays structural.
      const capSeam = garment && (isSleeveId(s.a.piece) !== isSleeveId(s.b.piece));
      // Untwist the CROSSED bodice shoulder seam with the rigid fold's globally-consistent sew
      // direction — but ONLY where that direction is in the right frame: both sides BODICE panels
      // (skirt/cap excluded) AND the fold lays the seam edges adjacent (small fold-layout pair gap).
      // The fold frame DISAGREES with the body wrap on open-closure SIDE seams (measured: skirt-side
      // fold pairing ~570mm vs ~170mm wrapped; a dress bodice-side flips just by attaching a skirt),
      // so trust the fold only when confident; everywhere else keep the wrapped direction (which
      // already closes those seams). bothBodice + (foldGap < 0.5·edgeLen) is the measured-clean gate.
      const bothBodice = garment && !capSeam && !isSkirtId(s.a.piece) && !isSkirtId(s.b.piece);
      let flip;
      if (!garment) {
        flip = deriveFlip(A, TA, s.a.edge, B, TB, s.b.edge);
      } else {
        const wf = deriveFlipWrapped(gplace[s.a.piece], A, s.a.edge, gplace[s.b.piece], B, s.b.edge);
        const fi = (bothBodice && TA && TB) ? foldFlipInfo(A, TA, s.a.edge, B, TB, s.b.edge) : null;
        flip = (fi && fi.gap < 0.5 * fi.elen) ? fi.flip : wf;   // trust the fold only when locally confident
      }
      const pairs = PM().seamPairs(ma.mesh, s.a.edge, mb.mesh, s.b.edge, { flip });
      for (const pr of pairs) {
        const gi = ma.start + pr[0], gj = mb.start + pr[1];
        if (capSeam) { kIc.push(gi); kJc.push(gj); }
        else { kI.push(gi); kJ.push(gj); kSeam.push(s.id); }
        seamLinks.push([gi, gj]);
      }
    }
    // DART self-seams (garments): sew each wedge dart's two legs shut WITHIN its piece, so the
    // dart collapses + shapes the panel (a bust dart rounds the bodice front). The mesh already
    // cut the wedge + tagged the legs (triangulatePiece via loweredBoundary). Bags have no darts.
    if (garment && PM().selfSeamPairs) {
      for (const pr of pieceRanges) {
        const p = byId[pr.piece], m = meshes[pr.piece];
        if (!p || !m || !(p.darts && p.darts.length)) continue;
        for (const d of p.darts) {
          if (d.kind !== "wedge") continue;
          // WELD (not a spring): a sewn dart is permanently shut — a spring lets gravity reopen it.
          for (const pp of PM().selfSeamPairs(m.mesh, d.id)) { const gi = m.start + pp[0], gj = m.start + pp[1]; weldI.push(gi); weldJ.push(gj); seamLinks.push([gi, gj]); }
        }
      }
    }

    // SLEEVE cap warm-start refine: snap each sleeve cap-boundary node ONTO its paired bodice armhole
    // node's warm-start position (+ a few mm outward), so the cap starts ON the armhole instead of
    // 50–140 mm off (the arch placement misses the curved armhole, and a stiff mesh can't be dragged
    // that far by the boundary seam alone). The cap interior + the sleeve body keep their hung placement.
    if (kIc.length) {
      const nodeSleeve0 = new Array(N).fill(false);
      for (const pr of pieceRanges) if (isSleeveId(pr.piece)) for (let q = 0; q < pr.count; q++) nodeSleeve0[pr.start + q] = true;
      for (let k = 0; k < kIc.length; k++) {
        const sleeveSide = nodeSleeve0[kIc[k]];
        const cap = sleeveSide ? kIc[k] : kJc[k], arm = sleeveSide ? kJc[k] : kIc[k];
        if (nodeSleeve0[arm]) continue;                      // a true cap pair has exactly one sleeve side
        const A = pos[arm], hyp = Math.hypot(A[0], A[2]) || 1, sc = 1 + 4 / hyp;   // nudge just OUTSIDE the body
        pos[cap] = [A[0] * sc, A[1], A[2] * sc];
      }
    }

    // ── inverse mass (area-weighted lumped, from the flat rest shape) ──
    const mass = new Float64Array(N);
    for (const t of tris) { const ar = triArea2D(localUV[t[0]], localUV[t[1]], localUV[t[2]]) / 3; mass[t[0]] += ar; mass[t[1]] += ar; mass[t[2]] += ar; }
    const invm = new Float64Array(N);
    for (let i = 0; i < N; i++) invm[i] = mass[i] > 1e-9 ? 1 / (mass[i] * massScale) : 0;   // fabric weight

    // ── state: position-Verlet (X current, P previous; velocity is implicit) ──
    const X = new Float64Array(3 * N), Pp = new Float64Array(3 * N);
    for (let i = 0; i < N; i++) { const q = pos[i]; X[3 * i] = Pp[3 * i] = q[0]; X[3 * i + 1] = Pp[3 * i + 1] = q[1]; X[3 * i + 2] = Pp[3 * i + 2] = q[2]; }

    // ── Sleeve arm-hug tether (Stage B2) ──────────────────────────────────────────────────
    // A set-in sleeve, sewn to an armhole that necessarily sits INBOARD of the arm (the arm must be
    // outboard to clear the torso), would otherwise sag straight off the thin limb into a pouch
    // underneath — "doesn't go around the arm". So each sleeve BODY node is confined to a thin shell
    // around its warm-start wrap on the arm (the inward analog of the bag inflation tether): it can
    // droop a little, but can't slide around to the underside. The cap region is left free to attach to
    // the armhole. Built from the wrap (mirror-symmetric) → both sleeves hug identically. Garment +
    // sleeve only; bags & sleeveless garments never populate armHug → byte-identical.
    const armRest = new Float64Array(3 * N), armHug = new Uint8Array(N);
    let nArmHug = 0, armHugOn = false;
    const ARM_HUG_CAP = (opts && opts.armHugCap) || 16;               // mm: max drift of a body node off its arm wrap
    if (garment && gplace) {
      // The cap-seam EDGE nodes stay FREE (welded onto the bodice armhole) — tethering them gathers the
      // eased cap into a bunched/crumpled mess (the "top gets messy") and a tight pull drags the bodice
      // seam open. Every OTHER sleeve node tethers to its GRADUAL wrap (cap region transitions armhole→arm
      // over the whole sleeve, so near the cap edge the target is close to the armhole, not the arm —
      // it can't yank the cap edge off + the cap stays smooth), and the lower body fully wraps the arm so
      // it can't sag off the thin limb. Built from the wrap → mirror-symmetric; garment+sleeve only.
      const capEdge = new Uint8Array(N);
      for (let k = 0; k < kIc.length; k++) { capEdge[kIc[k]] = 1; capEdge[kJc[k]] = 1; }
      for (const pr of pieceRanges) {
        const gp = gplace[pr.piece];
        if (!gp || gp.role !== "sleeve" || !gp.armTether) continue;
        for (let q = 0; q < pr.count; q++) {
          const i = pr.start + q; if (capEdge[i]) continue;
          const uv = localUV[i], tgt = gp.armTether(uv[0], uv[1]);
          if (tgt) { armHug[i] = 1; armRest[3 * i] = tgt[0]; armRest[3 * i + 1] = tgt[1]; armRest[3 * i + 2] = tgt[2]; nArmHug++; }
        }
      }
    }
    function armHugProject() {
      for (let i = 0; i < N; i++) {
        if (!armHug[i] || invm[i] === 0) continue;
        const o = 3 * i;
        const dx = X[o] - armRest[o], dy = X[o + 1] - armRest[o + 1], dz = X[o + 2] - armRest[o + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d > ARM_HUG_CAP) { const s = ARM_HUG_CAP / d; X[o] = armRest[o] + dx * s; X[o + 1] = armRest[o + 1] + dy * s; X[o + 2] = armRest[o + 2] + dz * s; }
      }
    }

    // constraint counts + per-list Lagrange multipliers (reset each substep)
    const nS = sI.length, nB = bI.length, nK = kI.length, nKc = kIc.length;
    const lamS = new Float64Array(nS), lamB = new Float64Array(nB), lamK = new Float64Array(nK), lamKc = new Float64Array(nKc);
    const pforce = new Float64Array(3 * N);
    const dt = 1 / 60, dt2 = dt * dt;
    const vmax = 0.5 * h;

    // ── self-collision setup (M5c-step3): a node-node repulsion floor so the draped cloth can't pass
    // through ITSELF (the lower-bodice crumple). Build a once-only exclusion Set of the node pairs that
    // are legitimately joined — triangle edges, stretch/bend springs, inter-piece seams, dart welds —
    // which must NEVER repel (else a closed seam or a sewn dart would be forced back open). Key = i*N+j
    // (i<j); N ≤ 65535 (Uint16 cap) → < 2^32, exact in a double. An index-distance heuristic is wrong
    // here: X[] concatenates multiple pieces, so adjacency does not correlate with |i−j|.
    const clothThick = opts.clothThick != null ? opts.clothThick : 0.5 * h;   // separation floor (10mm @ Std)
    const selfWindow = opts.selfWindow != null ? opts.selfWindow : 30;        // run in the final N settle substeps
    const doSelfCollide = garment && (opts.selfCollide !== false);            // garment-only; default ON
    const selfExclude = new Set();
    if (doSelfCollide) {
      const addExcl = (a, b) => { const i = a < b ? a : b, j = a < b ? b : a; if (i !== j) selfExclude.add(i * N + j); };
      for (const t of tris) { addExcl(t[0], t[1]); addExcl(t[1], t[2]); addExcl(t[2], t[0]); }
      for (let k = 0; k < nS; k++) addExcl(sI[k], sJ[k]);
      for (let k = 0; k < nB; k++) addExcl(bI[k], bJ[k]);
      for (let k = 0; k < nK; k++) addExcl(kI[k], kJ[k]);
      for (let k = 0; k < nKc; k++) addExcl(kIc[k], kJc[k]);   // cap pairs are joined → never self-repel
      for (let k = 0; k < weldI.length; k++) addExcl(weldI[k], weldJ[k]);
    }

    // XPBD distance projection over a flat constraint list (rest may be a Float64Array or 0).
    function projectDist(I, n, J, R, lam, alpha) {
      const at = alpha / dt2;
      for (let k = 0; k < n; k++) {
        const i = I[k], j = J[k], wi = invm[i], wj = invm[j], w = wi + wj;
        if (w === 0) continue;
        const ix = 3 * i, jx = 3 * j;
        let dx = X[ix] - X[jx], dy = X[ix + 1] - X[jx + 1], dz = X[ix + 2] - X[jx + 2];
        let l = Math.hypot(dx, dy, dz), nx, ny, nz;
        if (l < EPS) { nx = 1; ny = 0; nz = 0; }            // coincident (zero-rest seam) → arbitrary dir, ~0 correction
        else { nx = dx / l; ny = dy / l; nz = dz / l; }
        const Cv = l - (R ? R[k] : 0);
        const dl = (-Cv - at * lam[k]) / (w + at);
        lam[k] += dl;
        const cx = dl * nx, cy = dl * ny, cz = dl * nz;
        X[ix] += wi * cx; X[ix + 1] += wi * cy; X[ix + 2] += wi * cz;
        X[jx] -= wj * cx; X[jx + 1] -= wj * cy; X[jx + 2] -= wj * cz;
      }
    }

    // Per-face outward-normal pressure → per-node force (open-top safe; orient OUTWARD by the
    // bag node-centroid so winding/inward-facing panels don't matter).
    function accumulatePressure(P) {
      pforce.fill(0);
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < N; i++) { cx += X[3 * i]; cy += X[3 * i + 1]; cz += X[3 * i + 2]; }
      cx /= N; cy /= N; cz /= N;
      for (let t = 0; t < tris.length; t++) {
        const a = tris[t][0], b = tris[t][1], c = tris[t][2];
        const ax = X[3 * a], ay = X[3 * a + 1], az = X[3 * a + 2];
        const e1x = X[3 * b] - ax, e1y = X[3 * b + 1] - ay, e1z = X[3 * b + 2] - az;
        const e2x = X[3 * c] - ax, e2y = X[3 * c + 1] - ay, e2z = X[3 * c + 2] - az;
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;  // = 2·area·n̂
        const tcx = (ax + X[3 * b] + X[3 * c]) / 3, tcy = (ay + X[3 * b + 1] + X[3 * c + 1]) / 3, tcz = (az + X[3 * b + 2] + X[3 * c + 2]) / 3;
        if (nx * (tcx - cx) + ny * (tcy - cy) + nz * (tcz - cz) < 0) { nx = -nx; ny = -ny; nz = -nz; }  // point OUTWARD
        const f = P * 0.5 / 3;                              // |n| = 2·area → area-weighted; /3 per vertex
        for (const v of tris[t]) { pforce[3 * v] += nx * f; pforce[3 * v + 1] += ny * f; pforce[3 * v + 2] += nz * f; }
      }
    }

    // Garment forces (no-ops for the bag path — set by the garment driver below).
    let gAccel = 0;          // per-substep downward displacement (mm); = G·dt² eased in
    let collideOn = false;   // body collision against the dress form
    let selfCollideNow = false;   // cloth self-collision (armed only in the final settle window + reconcile)
    // One-sided analytic body collision: any node inside the form → project to the surface +
    // skin, and zero its velocity there (pseudo-friction, so the garment grips, not slides off).
    function bodyProject() {
      if (!form || !BF) return;
      for (let i = 0; i < N; i++) {
        if (invm[i] === 0) continue;                        // pins don't collide
        const o = 3 * i;
        const px = X[o], py = X[o + 1], pz = X[o + 2];
        if (BF.insideForm(form, [px, py, pz])) {
          const s = BF.nearestSurface(form, [px, py, pz], 6);        // normal horizontal (nx,0,nz)
          let vx = px - Pp[o], vz = pz - Pp[o + 2];                  // slide tangentially around the body,
          const nx = s.normal[0], nz = s.normal[2], vn = vx * nx + vz * nz;   // grip vertically (vy→0) so it hangs
          vx -= vn * nx; vz -= vn * nz;                             // from its pins — lets a side seam slide closed
          X[o] = s.point[0]; X[o + 1] = s.point[1]; X[o + 2] = s.point[2];
          Pp[o] = X[o] - vx; Pp[o + 1] = X[o + 1]; Pp[o + 2] = X[o + 2] - vz;
        }
      }
    }

    // Hard dart weld: snap each paired leg node to the pair midpoint (distance=0, enforced every
    // substep) so a sewn dart stays shut against gravity. Empty for bags → a true no-op.
    function projectWelds() {
      for (let w = 0; w < weldI.length; w++) {
        const oi = 3 * weldI[w], oj = 3 * weldJ[w];
        const mx = (X[oi] + X[oj]) / 2, my = (X[oi + 1] + X[oj + 1]) / 2, mz = (X[oi + 2] + X[oj + 2]) / 2;
        X[oi] = mx; X[oi + 1] = my; X[oi + 2] = mz; X[oj] = mx; X[oj + 1] = my; X[oj + 2] = mz;
      }
    }

    // Cloth SELF-collision (M5c-step3): push apart non-adjacent node pairs that have come within
    // clothThick of each other (a fold passing through its own layers). Uniform spatial hash at cell=h
    // (≥ clothThick so the 27-neighbourhood captures every colliding pair), rebuilt each call.
    // DETERMINISTIC: buckets are FILLED by ascending node index (so each bucket array is index-sorted),
    // and SWEPT outer-i ascending / inner j>i — every unordered pair is visited once in a fixed order;
    // we look buckets up by computed integer key and never iterate the map's own key order. Hard
    // inverse-mass-split push to the thickness (mirrors bodyProject); edits only X, never Pp (injects no
    // velocity). Pinned nodes (invm=0) are immovable → the whole push goes to the free partner.
    function projectSelfCollision() {
      if (!N) return;
      const cell = h, OFF = 1024, B = 2048;
      const buckets = Object.create(null);
      for (let i = 0; i < N; i++) {
        const o = 3 * i;
        const key = (Math.floor(X[o] / cell) + OFF) + (Math.floor(X[o + 1] / cell) + OFF) * B + (Math.floor(X[o + 2] / cell) + OFF) * B * B;
        (buckets[key] || (buckets[key] = [])).push(i);
      }
      const t2 = clothThick;
      for (let i = 0; i < N; i++) {
        const wi = invm[i], o = 3 * i;
        const cx = Math.floor(X[o] / cell) + OFF, cy = Math.floor(X[o + 1] / cell) + OFF, cz = Math.floor(X[o + 2] / cell) + OFF;
        for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) for (let az = -1; az <= 1; az++) {
          const b = buckets[(cx + ax) + (cy + ay) * B + (cz + az) * B * B]; if (!b) continue;
          for (let bi = 0; bi < b.length; bi++) {
            const j = b[bi]; if (j <= i) continue;
            if (selfExclude.has(i * N + j)) continue;
            const wj = invm[j], w = wi + wj; if (w === 0) continue;
            const oj = 3 * j;
            let dx = X[o] - X[oj], dy = X[o + 1] - X[oj + 1], dz = X[o + 2] - X[oj + 2];
            const l = Math.hypot(dx, dy, dz); if (l >= t2 || l < EPS) continue;
            const nx = dx / l, ny = dy / l, nz = dz / l, ci = wi / w, cj = wj / w;
            // approaching relative Verlet velocity along the contact normal (v = X − Pp), measured before
            // the positional push so it reflects true momentum, not the correction we are about to apply.
            const vrel = (X[o] - Pp[o] - (X[oj] - Pp[oj])) * nx + (X[o + 1] - Pp[o + 1] - (X[oj + 1] - Pp[oj + 1])) * ny + (X[o + 2] - Pp[o + 2] - (X[oj + 2] - Pp[oj + 2])) * nz;
            // (1) separate positionally to the thickness floor, split by inverse mass (mirrors projectDist).
            const corr = t2 - l;
            X[o] += ci * corr * nx; X[o + 1] += ci * corr * ny; X[o + 2] += ci * corr * nz;
            X[oj] -= cj * corr * nx; X[oj + 1] -= cj * corr * ny; X[oj + 2] -= cj * corr * nz;
            // (2) inelastic contact: if the layers are still approaching, remove that closing component via
            // Pp (no added restitution) so the separation STICKS — neither bounces apart (a hard X-only push
            // injects ≈vmax of outward Verlet velocity → a visible pop) nor re-rams (velocity-neutral keeps
            // the closing momentum). Pinned partners (ci or cj = 0) take none of it.
            if (vrel < 0) {
              Pp[o] += ci * vrel * nx; Pp[o + 1] += ci * vrel * ny; Pp[o + 2] += ci * vrel * nz;
              Pp[oj] -= cj * vrel * nx; Pp[oj + 1] -= cj * vrel * ny; Pp[oj + 2] -= cj * vrel * nz;
            }
          }
        }
      }
    }

    // One XPBD substep: integrate (inertia + pressure/gravity), project K iters, clamp, collide.
    // alphaCap = compliance for the EASED cap seams (kIc/kJc); defaults to alphaSeam. The phases pass a
    // LARGE alphaCap during the unpinned stitch-up (≈ no force, so the cap can't drag the shoulder) and
    // ease it down to the seam stiffness after the bodice pins.
    function substep(iters, alphaSeam, P, alphaCap) {
      if (alphaCap == null) alphaCap = alphaSeam;
      if (P > 0) accumulatePressure(P);
      for (let i = 0; i < N; i++) {
        const wi = invm[i];
        for (let d = 0; d < 3; d++) {
          const o = 3 * i + d, cur = X[o];
          let nx = cur + (cur - Pp[o]) * (1 - damp);        // damped inertia
          if (P > 0 && wi) nx += pforce[o] * wi;             // pressure displacement (bag)
          if (gAccel && d === 1 && wi > 0) nx += gAccel;     // gravity (garment): mass-independent, pins excluded
          Pp[o] = cur; X[o] = nx;
        }
      }
      lamS.fill(0); lamB.fill(0); lamK.fill(0); if (nKc) lamKc.fill(0);
      for (let it = 0; it < iters; it++) {
        projectDist(sI, nS, sJ, sR, lamS, C.stretch);
        projectDist(bI, nB, bJ, bR, lamB, C.bend);
        projectDist(kI, nK, kJ, null, lamK, alphaSeam);
        if (nKc) projectDist(kIc, nKc, kJc, null, lamKc, alphaCap);   // eased cap seams (phased; bag path has none)
      }
      let maxMove = 0;
      for (let i = 0; i < N; i++) {
        const o = 3 * i;
        let dx = X[o] - Pp[o], dy = X[o + 1] - Pp[o + 1], dz = X[o + 2] - Pp[o + 2];
        const mv = Math.hypot(dx, dy, dz);
        if (mv > vmax && mv > 0) { const sc = vmax / mv; X[o] = Pp[o] + dx * sc; X[o + 1] = Pp[o + 1] + dy * sc; X[o + 2] = Pp[o + 2] + dz * sc; }
        const fin = Math.min(mv, vmax);
        if (fin > maxMove) maxMove = fin;
      }
      if (weldI.length) projectWelds();
      if (collideOn) bodyProject();
      if (armHugOn && nArmHug) armHugProject();
      if (selfCollideNow) projectSelfCollision();
      return maxMove;
    }

    // Strain / "seam-tear" metric (GARMENT only, additive): per inter-piece-seam closure residual
    // (the kI/kJ pairs — dart welds are weldI/weldJ, NOT here) + the worst structural stretch ratio.
    // `overTension` drives the preview warning; `gapSegs` are the residual gap segments the 3D
    // highlight draws (so it survives the settled-mesh cache without seamLinks). Pure read of X.
    function computeStrain() {
      // Warn on a clearly-too-small pattern: a large un-closed seam gap. The threshold clears the
      // hanging-seam SOLVER noise floor — a FITTING skirt/dress side seam settles ~25–35 mm open near
      // the form's lower edge (more at Fine detail), which is a settle-tuning limitation, NOT a fit
      // problem — while a real misfit (child-size garment / a much larger body) gaps 100 mm+. A fitting
      // bodice closes to ~7 mm. (Stretch ratio is reported but too detail-noisy to gate on.)
      const GAP_T = opts.strainGapMm != null ? opts.strainGapMm : 50;        // mm
      const SEG_T = 15;                                                       // mm: only highlight segments past this
      // A seam with EASE (a set-in sleeve cap gathered into a shorter armhole) is MEANT to leave residual
      // fullness — that gap is the design, not a misfit, so exclude it from the over-tension gate/highlight.
      const easeSeam = new Set((seams || []).filter((s) => s.ease > 0).map((s) => s.id));
      const perSeam = {}; const order = [];
      let maxGap = 0, sumGap = 0; const gapSegs = [];
      for (let k = 0; k < nK; k++) {
        const id = kSeam[k] || "?";
        if (easeSeam.has(id)) continue;                                       // intentional cap ease, not a gap to warn on
        const oi = 3 * kI[k], oj = 3 * kJ[k];
        const d = Math.hypot(X[oi] - X[oj], X[oi + 1] - X[oj + 1], X[oi + 2] - X[oj + 2]);
        if (d > maxGap) maxGap = d; sumGap += d;
        if (!perSeam[id]) { perSeam[id] = 0; order.push(id); }
        if (d > perSeam[id]) perSeam[id] = d;
        if (d > SEG_T) gapSegs.push(X[oi], X[oi + 1], X[oi + 2], X[oj], X[oj + 1], X[oj + 2]);
      }
      // fabric stretch = p95 of edge length/rest, over edges with a free node (skip pinned-pinned —
      // frozen at the warm-start wrap, not fabric tension — and degenerate rests). p95 ignores the
      // odd mesh sliver / dart-apex edge so the signal reflects broad tension, not a single triangle.
      const ratios = [];
      for (let c = 0; c < nS; c++) {
        const rest = sR[c]; if (!(rest > 1e-6)) continue;
        if (invm[sI[c]] === 0 && invm[sJ[c]] === 0) continue;
        const oi = 3 * sI[c], oj = 3 * sJ[c];
        ratios.push(Math.hypot(X[oi] - X[oj], X[oi + 1] - X[oj + 1], X[oi + 2] - X[oj + 2]) / rest);
      }
      ratios.sort((a, b) => a - b);
      const maxStretch = ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))] : 1;
      const seamsOut = order.map((id) => ({ seam: id, gapMm: round4(perSeam[id]) })).sort((a, b) => b.gapMm - a.gapMm);
      const maxSeamGapMm = round4(maxGap), maxStretchRatio = round4(maxStretch);
      const wontClose = maxSeamGapMm > GAP_T;   // a too-small pattern can't reach around the body
      return {
        maxSeamGapMm, meanSeamGapMm: round4(nK ? sumGap / nK : 0), maxStretchRatio,
        overTension: wontClose,
        wontClose,
        seams: seamsOut, gapSegs,
      };
    }

    // ── GARMENT (M5c): wrap warm start → UNPINNED zero-g stitch-up (so the shoulder/top seam — which
    // sits in the pinned band — actually sews) → pin the stitched shoulder/waist line → gravity ramp +
    // body collision → settle → bounded stretch-to-fit reconciliation. A separate driver from the
    // bag's inflate path; same XPBD substep. ──
    if (garment) {
      const gSettleTol = 0.015 * h;
      const gFull = -G_MM * dt2 * (opts.gravity != null ? opts.gravity : 1);   // downward, mm/substep
      const stitchUnpinned = opts.stitchUnpinned !== false;                    // close the top seam BEFORE pinning (rollback: false)
      const maxStretchFrac = opts.maxStretchFrac != null ? opts.maxStretchFrac : 0.15;  // per-edge stretch ceiling (woven tears ~15%)
      const reconcileSteps = opts.reconcileSteps != null ? opts.reconcileSteps : 16;
      // seam-closeup (M5c-step3, BUG 2): zip a free-hanging side seam shut. A skirt's hem hangs BELOW the
      // form in free space where no body molds it + full gravity splays the two edges apart; harden the
      // inter-piece seam soft→near-weld while gravity is WEAK, hold it stiff, then re-settle under full
      // gravity. Inert on an already-closed (bodice / body-molded) seam.
      const closeSteps = opts.closeSteps != null ? opts.closeSteps : 12;
      const closeGrav = opts.closeGrav != null ? opts.closeGrav : 0.15;                  // gravity fraction during closure (not 0: keep the hang)
      const closeSeam0 = (opts.compliance && opts.compliance.closeSeam0) || C.seam1;     // start at the settle stiffness
      const closeSeam1 = (opts.compliance && opts.compliance.closeSeam1) || 1e-11;       // near-weld: zip the free seam shut + hold it
      const capOff = (opts.compliance && opts.compliance.capOff) || 1e2;                 // eased cap seam compliance during stitch-up ≈ no force (≫ seam0=1e-1)
      const capAttach = opts.capAttach != null ? opts.capAttach : 24;                    // zero-g substeps to pull the sleeve cap onto the armhole before gravity drops it
      const closeReSettle = opts.closeReSettle != null ? opts.closeReSettle : 24;
      const closeReGrav = opts.closeReGrav != null ? opts.closeReGrav : 0.2;             // re-settle gravity (low: the bulk drape is set; this just relaxes over-stretch + holds closure)
      const reSettleClamp = !!opts.reSettleClamp;                                        // clamp during re-settle (default OFF: it fights the seam closure on a free hem)
      // final surface smoothing: iron the high-frequency JAGGED folds (the compressed waist band, where
      // the pinned/welded/seamed edges meet draping fabric) with shape-preserving Taubin λ|μ passes —
      // μ<0 counters λ's shrink, so the garment doesn't deflate. Free nodes only; seams re-snap + body
      // re-projects after, so it can't open a seam or sink the cloth into the form.
      const smoothSteps = opts.smoothSteps != null ? opts.smoothSteps : 6;
      const smoothLambda = opts.smoothLambda != null ? opts.smoothLambda : 0.6;
      const smoothMu = opts.smoothMu != null ? opts.smoothMu : -0.63;
      const smoothSnapMm = opts.smoothSnapMm != null ? opts.smoothSnapMm : 20;           // only bridge/snap ALREADY-close seam pairs (an oversized misfit gap stays open + warned)
      const smoothPins = opts.smoothPins !== false;                                       // also smooth the pinned line: the jagged frozen WAIST is itself pinned (pinNow freezes it mid-stitch); shoulders shift only ~5mm
      const savedInvm = pins.map((i) => invm[i]);
      // Hard per-edge stretch ceiling: cap each structural edge at (1+maxStretchFrac)·rest. The XPBD
      // stretch spring alone creeps under sustained gravity (Gauss–Seidel, few iters/substep), so this
      // bounds elongation — applied in BOTH reconcile and the full-gravity re-settle (else the near-weld
      // seam holds while the fabric stretches downward, dropping the hem to the floor).
      const clampStretch = () => {
        for (let c = 0; c < nS; c++) {
          const rest = sR[c]; if (!(rest > 1e-6)) continue;
          const oi = 3 * sI[c], oj = 3 * sJ[c];
          const dx = X[oi] - X[oj], dy = X[oi + 1] - X[oj + 1], dz = X[oi + 2] - X[oj + 2];
          const d = Math.hypot(dx, dy, dz), lim = rest * (1 + maxStretchFrac);
          if (d > lim && d > EPS) {
            const wi = invm[sI[c]], wj = invm[sJ[c]], w = wi + wj; if (w === 0) continue;
            const corr = (d - lim) / d;
            X[oi] -= (wi / w) * corr * dx; X[oi + 1] -= (wi / w) * corr * dy; X[oi + 2] -= (wi / w) * corr * dz;
            X[oj] += (wj / w) * corr * dx; X[oj + 1] += (wj / w) * corr * dy; X[oj + 2] += (wj / w) * corr * dz;
          }
        }
      };
      // Pin shoulders/waist IN PLACE with zero velocity (the Verlet inertia term applies regardless of
      // invm, so Pp must be snapped to X or a freshly-pinned node keeps drifting). First push any pin
      // that drifted INSIDE the body during the collision-free stitch-up back out to the surface — a
      // pinned node skips collision forever, so an open neckline pinned inside would clip permanently.
      const pinNow = () => { for (const i of pins) {
        const o = 3 * i;
        if (form && BF && BF.insideForm(form, [X[o], X[o + 1], X[o + 2]])) {
          const s = BF.nearestSurface(form, [X[o], X[o + 1], X[o + 2]], 6);
          X[o] = s.point[0]; X[o + 1] = s.point[1]; X[o + 2] = s.point[2];
        }
        invm[i] = 0; Pp[o] = X[o]; Pp[o + 1] = X[o + 1]; Pp[o + 2] = X[o + 2];
      } };
      collideOn = !!form;                                  // body collision ON throughout: a hanging skirt's side seam molds
                                                           // CLOSED on the body this way (closing it in free space then settling
                                                           // re-opens it), and an open neckline can't collapse inside + get pinned
      if (!stitchUnpinned) pinNow();                       // legacy rollback: pin for the whole drape
      for (let k = 0; k < maxStitch; k++) {                // Phase 1: zero-gravity eased stitch-up (UNPINNED → top seam sews)
        const s = maxStitch > 1 ? k / (maxStitch - 1) : 1;
        const alphaSeam = Math.exp(lerp(Math.log(C.seam0), Math.log(C.seam1), smoothstep(s)));
        substep(stitchIters, alphaSeam, 0, capOff);        // cap seams INERT here (else they drag the shoulder before it pins)
      }
      if (stitchUnpinned) pinNow();                        // NOW pin the stitched shoulder/waist line (hangs from its support)
      armHugOn = true;                                      // hold the sleeve body on the arm through cap-attach + gravity (bodice stitch-up above is untouched)
      // SLEEVE cap-attach (M6): with the bodice closed + pinned, ease the cap seams capOff→near-weld in
      // ZERO-G so the sleeve closes onto the armhole BEFORE its own weight drops it away. The bodice
      // ARMHOLE nodes (the bodice side of each cap pair) are momentarily ANCHORED so the sleeve closes
      // onto a FIXED armhole (the cap reaches ~0 instead of dragging a semi-free armhole), then released
      // for the gravity settle. No-op when there are no cap seams.
      if (nKc) {
        const nodeSleeve = new Array(N).fill(false);
        for (const pr of pieceRanges) if (isSleeveId(pr.piece)) for (let q = 0; q < pr.count; q++) nodeSleeve[pr.start + q] = true;
        const anchorSet = new Set();
        for (let k = 0; k < nKc; k++) { const bn = nodeSleeve[kIc[k]] ? kJc[k] : kIc[k]; if (!nodeSleeve[bn]) anchorSet.add(bn); }
        const anchors = [...anchorSet], savedA = anchors.map((a) => invm[a]);
        for (const a of anchors) invm[a] = 0;
        gAccel = 0;
        for (let k = 0; k < capAttach; k++) {
          const aCap = Math.exp(lerp(Math.log(capOff), Math.log(closeSeam1), smoothstep(capAttach > 1 ? k / (capAttach - 1) : 1)));
          substep(settleIters, C.seam1, 0, aCap);   // near-weld: a set-in cap is firmly sewn (ease gathers in the fabric, not at the seam)
        }
        for (let i = 0; i < anchors.length; i++) invm[anchors[i]] = savedA[i];
      }
      let genergy = 0, gconv = false;                      // Phase 2: ease gravity in + settle on the form
      const gRamp = Math.min(40, Math.max(1, Math.round(maxSettle * 0.15)));
      const selfStart = Math.max(0, maxSettle - selfWindow);   // self-collision only in the final window (cheap)
      for (let k = 0; k < maxSettle; k++) {
        selfCollideNow = doSelfCollide && k >= selfStart;
        gAccel = gFull * smoothstep(Math.min(1, k / gRamp));
        genergy = substep(settleIters, C.seam1, 0, closeSeam1);   // cap already attached → near-weld holds it to the armhole under the sleeve's weight
        if (k > gRamp && genergy < gSettleTol) { gconv = true; break; }
      }
      // seam-closeup: zip the free-hanging side seam shut — harden the seam soft→near-weld while gravity
      // is WEAK so it can't splay the hem apart; self-collision on so a fold can't re-cross.
      selfCollideNow = doSelfCollide;
      for (let k = 0; k < closeSteps; k++) {
        const s = closeSteps > 1 ? k / (closeSteps - 1) : 1;
        gAccel = gFull * closeGrav;
        substep(settleIters, Math.exp(lerp(Math.log(closeSeam0), Math.log(closeSeam1), smoothstep(s))), 0, closeSeam1);
      }
      // Phase 3: bounded stretch-to-fit reconciliation under the SAME reduced gravity (so closure wins
      // over gravity tearing the free hem apart). Seam held near-weld; a per-edge stretch ceiling caps each
      // structural edge at (1+maxStretchFrac)·rest, so a too-small garment STRETCHES to bridge (up to the
      // limit, residual stays a flagged gap) not gap silently — and can't explode. Inert on a fitting one.
      gAccel = gFull * closeGrav;
      for (let k = 0; k < reconcileSteps; k++) { substep(settleIters, closeSeam1, 0, closeSeam1); clampStretch(); }
      // re-settle under FULL gravity so the now-closed garment hangs naturally; seam held stiff so the
      // closure HOLDS (a soft seam here would let full gravity re-open the free hem — the original bug),
      // stretch clamped so the fabric can't elongate to the floor, self-collision on so it stays
      // penetration-free. Re-measures convergence for the mode.
      gAccel = gFull * closeReGrav;
      for (let k = 0; k < closeReSettle; k++) { genergy = substep(settleIters, closeSeam1, 0, closeSeam1); if (reSettleClamp) clampStretch(); }
      selfCollideNow = false;
      // "settled" verdict from the BULK's motion (p90 of per-node last-substep move), not the worst node:
      // a self-collision contact can keep ONE node railing at vmax indefinitely (a stable jitter, not an
      // unsettled garment), so maxMove alone would never read "settled". p90 reflects the visible surface.
      const nmv = [];
      for (let i = 0; i < N; i++) { if (invm[i] === 0) continue; const o = 3 * i; nmv.push(Math.hypot(X[o] - Pp[o], X[o + 1] - Pp[o + 1], X[o + 2] - Pp[o + 2])); }
      nmv.sort((a, b) => a - b);
      genergy = nmv.length ? nmv[Math.floor(nmv.length * 0.9)] : genergy;
      if (genergy < gSettleTol) gconv = true;
      // Taubin surface smoothing (de-jag). Adjacency = triangle edges + the ALREADY-CLOSE seam/weld pairs,
      // so smoothing is consistent ACROSS a sewn seam and can't pull it open; FAR pairs (an oversized
      // misfit gap) are neither bridged nor snapped, so the genuine gap + its overTension warning survive.
      if (smoothSteps > 0) {
        const adj = Array.from({ length: N }, () => new Set());
        for (const t of tris) { adj[t[0]].add(t[1]); adj[t[0]].add(t[2]); adj[t[1]].add(t[0]); adj[t[1]].add(t[2]); adj[t[2]].add(t[0]); adj[t[2]].add(t[1]); }
        const near = (a, b) => Math.hypot(X[3 * a] - X[3 * b], X[3 * a + 1] - X[3 * b + 1], X[3 * a + 2] - X[3 * b + 2]) < smoothSnapMm;
        const snap = [];
        for (let k = 0; k < nK; k++) if (near(kI[k], kJ[k])) { adj[kI[k]].add(kJ[k]); adj[kJ[k]].add(kI[k]); snap.push(kI[k], kJ[k]); }
        for (let k = 0; k < weldI.length; k++) if (near(weldI[k], weldJ[k])) { adj[weldI[k]].add(weldJ[k]); adj[weldJ[k]].add(weldI[k]); snap.push(weldI[k], weldJ[k]); }
        const A = adj.map((s) => Array.from(s));
        const tmp = new Float64Array(3 * N);
        const lap = (w) => {
          for (let i = 0; i < N; i++) {
            const o = 3 * i;
            if ((invm[i] === 0 && !smoothPins) || !A[i].length) { tmp[o] = X[o]; tmp[o + 1] = X[o + 1]; tmp[o + 2] = X[o + 2]; continue; }  // pins stay put unless smoothPins
            let cx = 0, cy = 0, cz = 0; for (const j of A[i]) { cx += X[3 * j]; cy += X[3 * j + 1]; cz += X[3 * j + 2]; }
            const m = A[i].length; tmp[o] = X[o] + w * (cx / m - X[o]); tmp[o + 1] = X[o + 1] + w * (cy / m - X[o + 1]); tmp[o + 2] = X[o + 2] + w * (cz / m - X[o + 2]);
          }
          X.set(tmp);
        };
        for (let p = 0; p < smoothSteps; p++) { lap(smoothLambda); lap(smoothMu); }
        for (let s = 0; s < snap.length; s += 2) { const oi = 3 * snap[s], oj = 3 * snap[s + 1]; const mx = (X[oi] + X[oj]) / 2, my = (X[oi + 1] + X[oj + 1]) / 2, mz = (X[oi + 2] + X[oj + 2]) / 2; X[oi] = mx; X[oi + 1] = my; X[oi + 2] = mz; X[oj] = mx; X[oj + 1] = my; X[oj + 2] = mz; }
        if (collideOn) bodyProject();
      }
      // Honest per-seam STRAGGLER snap: a bodice shoulder seam can leave ONE corner pair (the neckline
      // corner the free edge pulled) as a bistable knife-edge straggler while the rest of the seam closed
      // (front+back are symmetric, but Gauss–Seidel order tips one side). If a seam is MOSTLY closed
      // (≥70% of its pairs within the snap threshold), snap its remaining near-stragglers to the pair
      // midpoint — closing the corner. A genuinely-too-small seam (most pairs far) is NOT mostly closed
      // → left untouched → it still gaps + drives overTension (honest). Capped so a large local defect
      // on an otherwise-closed seam isn't hidden. Body-reproject after so nothing snaps into the form.
      if (nK) {
        const snapMm = smoothSnapMm, capMm = 90, gapOf = (k) => Math.hypot(X[3 * kI[k]] - X[3 * kJ[k]], X[3 * kI[k] + 1] - X[3 * kJ[k] + 1], X[3 * kI[k] + 2] - X[3 * kJ[k] + 2]);
        const bySeam = {}; for (let k = 0; k < nK; k++) { const id = kSeam[k] || "?"; (bySeam[id] || (bySeam[id] = [])).push(k); }
        let snapped = false;
        for (const id in bySeam) {
          const ks = bySeam[id]; let closed = 0; for (const k of ks) if (gapOf(k) < snapMm) closed++;
          if (closed / ks.length < 0.7) continue;                         // a genuinely-open seam → leave it (warns)
          for (const k of ks) { const g = gapOf(k); if (g < snapMm || g > capMm) continue;
            const oi = 3 * kI[k], oj = 3 * kJ[k], mx = (X[oi] + X[oj]) / 2, my = (X[oi + 1] + X[oj + 1]) / 2, mz = (X[oi + 2] + X[oj + 2]) / 2;
            X[oi] = mx; X[oi + 1] = my; X[oi + 2] = mz; X[oj] = mx; X[oj + 1] = my; X[oj + 2] = mz; snapped = true; }
        }
        if (snapped && collideOn) bodyProject();
      }
      const strain = computeStrain();
      for (let j = 0; j < pins.length; j++) invm[pins[j]] = savedInvm[j];
      const gnodes = [];
      for (let i = 0; i < N; i++) gnodes.push([X[3 * i], X[3 * i + 1], X[3 * i + 2]]);
      const gmode = (!form || !pins.length) ? "degraded" : (gconv ? "settled" : "warm");
      return { nodes: gnodes, tris, pieceRanges, localUV, seamLinks, welds: [], mode: gmode, energy: round4(genergy), strain };
    }

    // ── Phase B+C: zero-gravity stitch-up (gravity+pressure OFF; ease seam stiffness) ──
    for (let k = 0; k < maxStitch; k++) {
      const s = maxStitch > 1 ? k / (maxStitch - 1) : 1;
      const alphaSeam = Math.exp(lerp(Math.log(C.seam0), Math.log(C.seam1), smoothstep(s)));
      substep(stitchIters, alphaSeam, 0);
    }

    // ── Phase E + Inflation: settle with eased-in per-face pressure; freeze on low motion ──
    // Inflation needs a sewn bag (seam constraints close the surface enough for per-face
    // pressure to round it); a seamless single sheet just settles flat (no puff, no degenerate
    // centroid-flip on a planar mesh).
    let energy = 0, converged = false;
    const doInflate = pressure > 0 && nK > 0;
    const inflateRamp = Math.min(30, Math.max(1, Math.round(maxSettle * 0.2)));
    const settleTol = 0.015 * h;
    // Inflation tether: snapshot the stitched shape + bound how far each node may drift from it,
    // so per-face pressure ROUNDS the bag to a bounded puff instead of running away into a
    // balloon (the free top edges otherwise buckle outward at a sharp pressure threshold). Above
    // that threshold the cap — not the knife-edge pressure — sets the final shape: robust.
    const W = doInflate ? X.slice() : null;
    let maxInflate = Infinity;
    if (doInflate) {
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < N; i++) for (let d = 0; d < 3; d++) { const v = X[3 * i + d]; if (v < lo[d]) lo[d] = v; if (v > hi[d]) hi[d] = v; }
      maxInflate = inflateCap * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    }
    for (let k = 0; k < maxSettle; k++) {
      const P = doInflate ? pressure * smoothstep(k / inflateRamp) : 0;
      energy = substep(settleIters, C.seam1, P);
      if (W && isFinite(maxInflate)) {                    // tether each node to its stitched position
        for (let i = 0; i < N; i++) {
          const o = 3 * i, dx = X[o] - W[o], dy = X[o + 1] - W[o + 1], dz = X[o + 2] - W[o + 2];
          const dd = Math.hypot(dx, dy, dz);
          if (dd > maxInflate) { const sc = maxInflate / dd; X[o] = W[o] + dx * sc; X[o + 1] = W[o + 1] + dy * sc; X[o + 2] = W[o + 2] + dz * sc; }
        }
      }
      if (k > inflateRamp && energy < settleTol) { converged = true; break; }
    }

    const nodes = [];
    for (let i = 0; i < N; i++) nodes.push([X[3 * i], X[3 * i + 1], X[3 * i + 2]]);

    let mode;
    if (!maxStitch && !maxSettle) mode = "warm";
    else if (fold.mode !== "closed") mode = "degraded";
    else mode = converged ? "settled" : "warm";

    return { nodes, tris, pieceRanges, localUV, seamLinks, welds: [], mode, energy: round4(energy) };
  }

  // Sew direction (head-to-tail vs head-to-head), derived from the warm-start 3D geometry —
  // mirrors pattern-fold.inferFlip: place each seam edge's two endpoints, pick the nearer
  // pairing. Returns true (flip = head-to-head) when A0↔B0/A1↔B1 is nearer than A0↔B1/A1↔B0.
  function deriveFlip(A, TA, ea, B, TB, eb) {
    if (!A || !B || !TA || !TB) return false;
    const nA = A.nodes.length, nB = B.nodes.length;
    const A0 = applyT(TA, nodeXY(A, ea)), A1 = applyT(TA, nodeXY(A, (ea + 1) % nA));
    const B0 = applyT(TB, nodeXY(B, eb)), B1 = applyT(TB, nodeXY(B, (eb + 1) % nB));
    const ht = Math.max(dist3(A0, B1), dist3(A1, B0));   // head-to-tail
    const hh = Math.max(dist3(A0, B0), dist3(A1, B1));   // head-to-head
    return hh < ht;
  }

  // Like deriveFlip, but also returns the CHOSEN pairing's gap + the edge length, so the garment
  // path can trust the fold direction only where the fold lays the seam edges ADJACENT (gap ≪
  // edgeLen). Used to gate the bodice-shoulder untwist (the fold frame is unreliable for the
  // open-closure side seams, which it lays far apart).
  function foldFlipInfo(A, TA, ea, B, TB, eb) {
    if (!A || !B || !TA || !TB) return null;
    const nA = A.nodes.length, nB = B.nodes.length;
    const A0 = applyT(TA, nodeXY(A, ea)), A1 = applyT(TA, nodeXY(A, (ea + 1) % nA));
    const B0 = applyT(TB, nodeXY(B, eb)), B1 = applyT(TB, nodeXY(B, (eb + 1) % nB));
    const ht = Math.max(dist3(A0, B1), dist3(A1, B0));
    const hh = Math.max(dist3(A0, B0), dist3(A1, B1));
    return { flip: hh < ht, gap: Math.min(ht, hh), elen: dist3(A0, A1) };
  }

  // ── geomHash (Phase-2 settled-drape cache key; pure, used on both write + validate) ──
  // FNV-1a 32-bit over the geometry inputs the drape consumes: each piece's id + nodes,
  // each seam's refs + direction bit, plus h + foldRoot + SIM_VERSION. Any edit flips it.
  function fnv1a(str) {
    let hsh = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { hsh ^= str.charCodeAt(i); hsh = Math.imul(hsh, 0x01000193); }
    return (hsh >>> 0).toString(16).padStart(8, "0");
  }
  function flipBit(anchors) {
    if (Array.isArray(anchors) && anchors[0] && typeof anchors[0].ta === "number")
      return Math.abs(anchors[0].ta - anchors[0].tb) < 0.5 ? "1" : "0";
    return "-";
  }
  function geomHash(pieces, seams, opts) {
    opts = opts || {};
    const G = PG();
    if (G && G.normalizePieces) pieces = G.normalizePieces({ pieces: pieces || [] });
    if (G && G.normalizeSeams) seams = G.normalizeSeams(seams || [], pieces);
    const q = (v) => Math.round(v * 100) / 100;
    const parts = [];
    for (const p of pieces || []) { parts.push(p.id); for (const n of p.nodes) parts.push(q(n.x), q(n.y)); }
    for (const s of seams || []) parts.push(s.id, s.a.piece, s.a.edge, s.b.piece, s.b.edge, flipBit(s.anchors));
    // Garment drape inputs — only when present, so a BAG's hash is byte-identical to before.
    if (opts.garment || opts.body) {
      const b = opts.body || {};
      parts.push("g=1", "fab=" + (opts.fabric || "cotton"), "body=" + [b.heightMm, b.bustMm, b.waistMm, b.hipMm].join(","));
      // self-collision knobs (garment-only → bag hash byte-identical): toggling/retuning re-keys the cache.
      parts.push("sc=" + (opts.selfCollide === false ? 0 : 1), "thick=" + (opts.clothThick != null ? opts.clothThick : 0.5 * (opts.h > 0 ? opts.h : DEFAULTS.h)), "scw=" + (opts.selfWindow != null ? opts.selfWindow : 30), "sm=" + (opts.smoothSteps != null ? opts.smoothSteps : 6));
      for (const p of pieces || []) {
        for (const d of (p.darts || [])) parts.push("d", d.edge, q(d.center), q(d.width), q(d.depth), d.kind);
        for (const k in (p.edges || {})) parts.push("e", k, JSON.stringify(p.edges[k].curve));
        if (p.place3d) parts.push("p3", p.place3d.role || "", p.place3d.wrap || "");
      }
    }
    parts.push("h=" + (opts.h > 0 ? opts.h : DEFAULTS.h), "root=" + (opts.root || ""), "v=" + SIM_VERSION);
    return fnv1a(parts.join("\x1f"));
  }

  const round4 = (v) => Math.round(v * 10000) / 10000;

  // ── settled-drape cache codec (Phase-2 §3.4) ──────────────────────────────────────────
  // Quantize the settled mesh to int16 @0.1 mm (positions + per-node local UV) + Uint16 tri
  // indices, base64-packed, so it rides the opaque params_json (no server change) at tens of KB.
  // Coordinates fit ±3276.7 mm; indices fit 65535 nodes — both far beyond a household pattern.
  // little-endian on every target device (x86/ARM); decode is the exact inverse.
  const CH = 8192;
  function b64FromBytes(u8) { let s = ""; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function bytesFromB64(b64) { const s = atob(b64), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
  function quantI16(flat) { const out = new Int16Array(flat.length); for (let i = 0; i < flat.length; i++) { let v = Math.round(flat[i] * 10); out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; } return out; }

  // encodeDrape(result) → an opaque blob to stash at params.preview3d (caller adds geomHash/h/settledAt).
  function encodeDrape(result) {
    const N = result.nodes.length, T = result.tris.length;
    const nflat = new Float64Array(3 * N), uflat = new Float64Array(2 * N), tflat = new Uint16Array(3 * T);
    for (let i = 0; i < N; i++) { const p = result.nodes[i], u = result.localUV[i]; nflat[3 * i] = p[0]; nflat[3 * i + 1] = p[1]; nflat[3 * i + 2] = p[2]; uflat[2 * i] = u[0]; uflat[2 * i + 1] = u[1]; }
    for (let i = 0; i < T; i++) { const t = result.tris[i]; tflat[3 * i] = t[0]; tflat[3 * i + 1] = t[1]; tflat[3 * i + 2] = t[2]; }
    return {
      simVersion: SIM_VERSION, nodeCount: N, triCount: T,
      nodes: b64FromBytes(new Uint8Array(quantI16(nflat).buffer)),
      localUV: b64FromBytes(new Uint8Array(quantI16(uflat).buffer)),
      tris: b64FromBytes(new Uint8Array(tflat.buffer)),
      pieceRanges: result.pieceRanges,
    };
  }
  // decodeDrape(blob) → the same shape drapeToGroup consumes (nodes/tris/pieceRanges/localUV).
  function decodeDrape(blob) {
    const N = blob.nodeCount, T = blob.triCount;
    const ni = new Int16Array(bytesFromB64(blob.nodes).buffer), ui = new Int16Array(bytesFromB64(blob.localUV).buffer), ti = new Uint16Array(bytesFromB64(blob.tris).buffer);
    const nodes = new Array(N), localUV = new Array(N), tris = new Array(T);
    for (let i = 0; i < N; i++) { nodes[i] = [ni[3 * i] / 10, ni[3 * i + 1] / 10, ni[3 * i + 2] / 10]; localUV[i] = [ui[2 * i] / 10, ui[2 * i + 1] / 10]; }
    for (let i = 0; i < T; i++) tris[i] = [ti[3 * i], ti[3 * i + 1], ti[3 * i + 2]];
    return { nodes, tris, localUV, pieceRanges: blob.pieceRanges, seamLinks: [], welds: [], mode: "cached", energy: 0 };
  }

  window.PatternCloth = { solveDrape, geomHash, deriveFlip, encodeDrape, decodeDrape, hasSleevePiece, SIM_VERSION };
})();
