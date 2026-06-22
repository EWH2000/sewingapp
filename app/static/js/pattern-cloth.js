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

  const SIM_VERSION = 1;

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
    const FRONT = [-85 * DEG, 85 * DEG], BACK = [95 * DEG, 265 * DEG], SIDE_R = [40 * DEG, 140 * DEG], SIDE_L = [220 * DEG, 320 * DEG];
    const place = {};
    pieces.forEach((p, idx) => {
      const nm = (p.name || "").toLowerCase();
      // straps + finishing strips (waistband/binding/facing) are not draping panels.
      if (isStrap(p, seams) || /waistband|binding|facing|band/.test(nm)) return;
      const nodes = p.nodes || []; if (!nodes.length) return;
      const bx = pieceBBoxX(nodes), by = pieceBBoxY(nodes);
      const role = (p.place3d && p.place3d.role) || inferRole(p, idx);
      // skirt/back can come from the role OR the piece name (robust to hand-authored naming).
      const isBack = /back/.test(role) || (!/front/.test(role) && /back/.test(nm));
      const isSkirt = /skirt/.test(role) || /skirt/.test(nm);
      let sector = isBack ? BACK : FRONT;
      if (/side/.test(role)) sector = /left|_l|-l/.test(role) ? SIDE_L : SIDE_R;
      const yHi = isSkirt ? waistY : shoulderY;
      const yLo = isSkirt ? waistY - by.H : waistY;        // skirt hangs from the waist by its own height
      const wrap = (lx, ly) => {
        const u = (lx - bx.lo) / bx.W, v = (ly - by.lo) / by.H;
        const th = sector[0] + u * (sector[1] - sector[0]);
        const wy = yLo + v * (yHi - yLo);
        const r = ringAt(wy);
        return [(r.a + skin + gap) * Math.sin(th), wy, (r.b + skin + gap) * Math.cos(th)];
      };
      const pinTest = (lx, ly) => (ly - by.lo) / by.H >= 0.92;   // top edge held
      place[p.id] = { wrap, pinTest, role };
    });
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
      form = BF.loft(opts.body || BF.DEFAULT_BODY);
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
    const seamLinks = [], kI = [], kJ = [];
    for (const s of seams) {
      if (s.a.piece === s.b.piece) continue;                          // self/dart seam — Step 3b
      const ma = meshes[s.a.piece], mb = meshes[s.b.piece];
      if (!ma || !mb) continue;                                       // strap seam, or a dropped piece
      const TA = transforms[s.a.piece], TB = transforms[s.b.piece];
      const A = byId[s.a.piece], B = byId[s.b.piece];
      const flip = garment
        ? deriveFlipWrapped(gplace[s.a.piece], A, s.a.edge, gplace[s.b.piece], B, s.b.edge)
        : deriveFlip(A, TA, s.a.edge, B, TB, s.b.edge);
      const pairs = PM().seamPairs(ma.mesh, s.a.edge, mb.mesh, s.b.edge, { flip });
      for (const pr of pairs) { const gi = ma.start + pr[0], gj = mb.start + pr[1]; kI.push(gi); kJ.push(gj); seamLinks.push([gi, gj]); }
    }

    // ── inverse mass (area-weighted lumped, from the flat rest shape) ──
    const mass = new Float64Array(N);
    for (const t of tris) { const ar = triArea2D(localUV[t[0]], localUV[t[1]], localUV[t[2]]) / 3; mass[t[0]] += ar; mass[t[1]] += ar; mass[t[2]] += ar; }
    const invm = new Float64Array(N);
    for (let i = 0; i < N; i++) invm[i] = mass[i] > 1e-9 ? 1 / (mass[i] * massScale) : 0;   // fabric weight

    // ── state: position-Verlet (X current, P previous; velocity is implicit) ──
    const X = new Float64Array(3 * N), Pp = new Float64Array(3 * N);
    for (let i = 0; i < N; i++) { const q = pos[i]; X[3 * i] = Pp[3 * i] = q[0]; X[3 * i + 1] = Pp[3 * i + 1] = q[1]; X[3 * i + 2] = Pp[3 * i + 2] = q[2]; }

    // constraint counts + per-list Lagrange multipliers (reset each substep)
    const nS = sI.length, nB = bI.length, nK = kI.length;
    const lamS = new Float64Array(nS), lamB = new Float64Array(nB), lamK = new Float64Array(nK);
    const pforce = new Float64Array(3 * N);
    const dt = 1 / 60, dt2 = dt * dt;
    const vmax = 0.5 * h;

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
    // One-sided analytic body collision: any node inside the form → project to the surface +
    // skin, and zero its velocity there (pseudo-friction, so the garment grips, not slides off).
    function bodyProject() {
      if (!form || !BF) return;
      for (let i = 0; i < N; i++) {
        if (invm[i] === 0) continue;                        // pins don't collide
        const o = 3 * i;
        if (BF.insideForm(form, [X[o], X[o + 1], X[o + 2]])) {
          const s = BF.nearestSurface(form, [X[o], X[o + 1], X[o + 2]], 6);
          X[o] = s.point[0]; X[o + 1] = s.point[1]; X[o + 2] = s.point[2];
          Pp[o] = X[o]; Pp[o + 1] = X[o + 1]; Pp[o + 2] = X[o + 2];
        }
      }
    }

    // One XPBD substep: integrate (inertia + pressure/gravity), project K iters, clamp, collide.
    function substep(iters, alphaSeam, P) {
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
      lamS.fill(0); lamB.fill(0); lamK.fill(0);
      for (let it = 0; it < iters; it++) {
        projectDist(sI, nS, sJ, sR, lamS, C.stretch);
        projectDist(bI, nB, bJ, bR, lamB, C.bend);
        projectDist(kI, nK, kJ, null, lamK, alphaSeam);
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
      if (collideOn) bodyProject();
      return maxMove;
    }

    // ── GARMENT (M5c): wrap warm start → zero-g stitch-up (pins on) → gravity ramp + body
    // collision → settle. A separate driver from the bag's inflate path; same XPBD substep. ──
    if (garment) {
      const gSettleTol = 0.015 * h;
      const gFull = -G_MM * dt2 * (opts.gravity != null ? opts.gravity : 1);   // downward, mm/substep
      const savedInvm = pins.map((i) => invm[i]);
      for (const i of pins) invm[i] = 0;                  // pin shoulders/waist for the whole drape (hangs from its support)
      collideOn = !!form;                                  // body collision (warm start is outside, so gentle)
      for (let k = 0; k < maxStitch; k++) {                // Phase 1: zero-gravity eased stitch-up
        const s = maxStitch > 1 ? k / (maxStitch - 1) : 1;
        const alphaSeam = Math.exp(lerp(Math.log(C.seam0), Math.log(C.seam1), smoothstep(s)));
        substep(stitchIters, alphaSeam, 0);
      }
      let genergy = 0, gconv = false;                      // Phase 2: ease gravity in + settle on the form
      const gRamp = Math.min(40, Math.max(1, Math.round(maxSettle * 0.15)));
      for (let k = 0; k < maxSettle; k++) {
        gAccel = gFull * smoothstep(Math.min(1, k / gRamp));
        genergy = substep(settleIters, C.seam1, 0);
        if (k > gRamp && genergy < gSettleTol) { gconv = true; break; }
      }
      for (let j = 0; j < pins.length; j++) invm[pins[j]] = savedInvm[j];
      const gnodes = [];
      for (let i = 0; i < N; i++) gnodes.push([X[3 * i], X[3 * i + 1], X[3 * i + 2]]);
      const gmode = (!form || !pins.length) ? "degraded" : (gconv ? "settled" : "warm");
      return { nodes: gnodes, tris, pieceRanges, localUV, seamLinks, welds: [], mode: gmode, energy: round4(genergy) };
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

  window.PatternCloth = { solveDrape, geomHash, deriveFlip, encodeDrape, decodeDrape, SIM_VERSION };
})();
