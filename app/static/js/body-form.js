/* body-form.js — a procedural parametric "dress form" (window.BodyForm), Step 3b (M5b).
 *
 * PURE: no three.js, no DOM, no RNG — mirrors pattern-mesh.js / pattern-fold.js so the
 * headless tools/preview/*.mjs tests can eval it in Node. three.js meets it only in
 * preview3d.js (which tessellates the ring stack into a BufferGeometry).
 *
 * A limbless torso lofted from a hand-authored 2D silhouette through a stack of ELLIPTICAL
 * cross-section rings (wider than deep). bust/waist/hip circumferences come from the doc's
 * `body` measurements; the ring (a,b) semi-axes are solved CLOSED-FORM from the target
 * circumference at a fixed depth:width aspect (Ramanujan's perimeter approximation inverts to
 * a single constant for fixed aspect), Hermite-interpolated between bands, height scales Y.
 *
 * Collision is ANALYTIC (no SMPL, no mesh/SDF, no BVH — following GarmentCodeData): look up
 * the ring (a,b) at a height by interpolation, test (x/a)²+(z/b)²<1; project an inside point
 * radially to the ellipse boundary + a skin offset. O(1) per query. The renderer and the M5c
 * solver share the SAME `stack` object (preview3d puts it on group.userData.stack) so the
 * visible form and the collider can never drift.
 *
 * Coordinate convention (matches the rest of the 3D preview): millimetres, Y-up, the form's
 * hem sits on the floor (yMin = 0), centred on the Y axis (cx = cz = 0).
 */
(function () {
  "use strict";

  // depth:width aspect (b/a). Human torsos are wider than deep. Fixed for M5b (the plan's
  // "fixed depth:width aspect") — a per-band override is the first tuning lever if needed.
  const ASPECT = 0.72;
  const DEFAULT_BODY = { heightMm: 1650, bustMm: 920, waistMm: 740, hipMm: 980 };

  // Analytic ARM capsules (Stage B2) — appended to the loft return ONLY when opts.arms is
  // truthy, so the limbless (no-arms) form is byte-identical. A sleeve drapes OVER these.
  // Tapered round capsules: socket just outside the shoulder ellipse, a FULL arm to the wrist,
  // axis down-and-out. Bicep/wrist GIRTHS derive from bust (no doc field) unless authored.
  const ARM = {
    bicepFromBust: 0.32,   // bicep circumference ≈ 0.32·bust  [GATE]
    wristFromBicep: 0.58,  // wrist circumference ≈ 0.58·bicep [GATE]
    lenFrac: 0.42,         // arm length as a fraction of stature (to the wrist) [GATE]
    downDeg: 12,           // axis tilt off vertical (down-and-out). 12° drapes CONSISTENTLY across
                           // garments (both sleeves wrap with only a mild front/back offset) and keeps
                           // the arm∩torso overlap shallow (low armpit penetration). [GATE]
    socketOut: 0.85,       // socket sits r0·0.85 beyond the shoulder side — close enough to FILL the
                           // sleeve (the owner's goal), far enough that the torso∩arm overlap stays
                           // shallow (the armpit residual is a soft-body limit, kept ≲ test bound). [GATE]
    socketDrop: 0.02,      // dropped 0.02·H below the shoulder band [GATE]
    rMin: 20,              // radius floor (mm) — guards a garbage bicep
    rMaxFrac: 0.6,         // radius ceiling = 0.6·shoulder.a — can't swallow the torso
    sleeveEase: 0.08,      // the arm is drawn/collided this much THINNER than the sleeve's bicep, so a
  };                       // fitted sleeve (≈ arm girth) has wearing ease to sit just OUTSIDE it. [GATE]

  // Silhouette bands, each at its ANATOMICAL height as a fraction of stature (`yf` = height/
  // stature). The limbless torso floats on an implied stand (hem ≈ mid-thigh, shoulder ≈ acromion)
  // so a skirt/dress has room to HANG below the waist toward the floor. `meas` ties a band to a
  // measurement; `k` scales that circumference (1.0 = exactly the measurement). The waist pinch +
  // bust peak make it read as a dress form, not a tube.
  const PROFILE = [
    { yf: 0.42, role: "hem",       meas: "hipMm",   k: 0.94 },  // mid-thigh stop
    { yf: 0.47, role: "thigh",     meas: "hipMm",   k: 0.99 },
    { yf: 0.53, role: "hip",       meas: "hipMm",   k: 1.00 },  // widest lower band
    { yf: 0.62, role: "waist",     meas: "waistMm", k: 1.00 },  // natural waist (narrowest)
    { yf: 0.68, role: "underbust", meas: "waistMm", k: 1.06 },
    { yf: 0.73, role: "bust",      meas: "bustMm",  k: 1.00 },  // bust peak
    { yf: 0.79, role: "chest",     meas: "bustMm",  k: 0.86 },  // above-bust, narrows
    { yf: 0.84, role: "shoulder",  meas: "bustMm",  k: 0.80 },  // shoulder (acromion); no neck/arms
  ];

  // Ramanujan's first ellipse-perimeter approximation, factored for fixed aspect r = b/a:
  //   P ≈ π[3(a+b) − √((3a+b)(a+3b))] = a · π[3(1+r) − √((3+r)(1+3r))] = a · K(r).
  // So K(r) is a constant and semiAxesForCirc is exact + O(1) (no Newton iteration).
  function ellipseK(r) { return Math.PI * (3 * (1 + r) - Math.sqrt((3 + r) * (1 + 3 * r))); }
  function semiAxesForCirc(C, r) { const a = C / ellipseK(r); return { a, b: r * a }; }

  // Hermite (Catmull-Rom-tangent) interpolation of a(y) over non-uniformly spaced anchors,
  // clamped outside the range. Tangents are finite differences over the real y spacing, so the
  // non-uniform band heights are handled correctly. One spline suffices: b = ASPECT·a everywhere.
  function splineA(anchors, y) {
    const n = anchors.length;
    if (y <= anchors[0].y) return anchors[0].a;
    if (y >= anchors[n - 1].y) return anchors[n - 1].a;
    let i = 0; while (i < n - 1 && anchors[i + 1].y < y) i++;   // segment [i, i+1]
    const p0 = anchors[i], p1 = anchors[i + 1];
    const h = p1.y - p0.y; if (h <= 0) return p0.a;
    const t = (y - p0.y) / h;
    const slope = (lo, hi) => (anchors[hi].a - anchors[lo].a) / (anchors[hi].y - anchors[lo].y);
    const m0 = (i === 0) ? slope(0, 1) : slope(i - 1, i + 1);
    const m1 = (i + 1 === n - 1) ? slope(n - 2, n - 1) : slope(i, i + 2);
    const t2 = t * t, t3 = t2 * t;
    // Hermite basis, tangents scaled by the segment width h.
    return (2 * t3 - 3 * t2 + 1) * p0.a + (t3 - 2 * t2 + t) * h * m0
         + (-2 * t3 + 3 * t2) * p1.a + (t3 - t2) * h * m1;
  }

  function fillBody(body) {
    body = body || {};
    return {
      heightMm: +body.heightMm > 0 ? +body.heightMm : DEFAULT_BODY.heightMm,
      bustMm: +body.bustMm > 0 ? +body.bustMm : DEFAULT_BODY.bustMm,
      waistMm: +body.waistMm > 0 ? +body.waistMm : DEFAULT_BODY.waistMm,
      hipMm: +body.hipMm > 0 ? +body.hipMm : DEFAULT_BODY.hipMm,
    };
  }

  // body {heightMm,bustMm,waistMm,hipMm} → a ring-stack descriptor. opts.rings = slice count.
  // Bands sit at their anatomical world heights (yf·height), so the torso FLOATS (hem at
  // ~0.42·height, shoulder at ~0.84·height) — a skirt hangs from the waist toward the floor.
  function loft(body, opts) {
    opts = opts || {};
    const b = fillBody(body);
    const aspect = opts.aspect || ASPECT;
    const profile = opts.profile || PROFILE;
    const H = b.heightMm;
    const yLo = profile[0].yf * H, yHi = profile[profile.length - 1].yf * H;
    // anchor rings: solve each band's semi-axis from its circumference, at its world height.
    const anchors = profile.map((band) => {
      const C = band.k * b[band.meas];
      return { y: band.yf * H, a: semiAxesForCirc(C, aspect).a, role: band.role };
    });
    const bands = anchors.map((an) => ({ y: an.y, role: an.role, a: an.a, b: aspect * an.a }));
    // resample to a smooth stack of `rings` slices (default 48) from hem to shoulder.
    const nRings = Math.max(8, opts.rings || 48);
    const rings = [];
    for (let i = 0; i < nRings; i++) {
      const y = yLo + ((yHi - yLo) * i) / (nRings - 1);
      const a = splineA(anchors, y);
      rings.push({ y: y, a: a, b: aspect * a, cx: 0, cz: 0 });
    }
    const out = { rings, yMin: yLo, yMax: yHi, body: b, bands, aspect };
    if (opts.arms) out.arms = buildArms(b, bands, opts.arm);   // keyless otherwise → no-arms loft byte-identical
    return out;
  }

  // Two tapered round capsules (L/R) from the shoulder band + bicep/wrist circumferences.
  // Returned on stack.arms; the renderer (preview3d) and the M5c collider both read this same
  // descriptor (shared-stack invariant). Bicep/wrist derive from bust unless authored on `b`.
  function buildArms(b, bands, override) {
    const sh = bands.find((bd) => bd.role === "shoulder");
    if (!sh) return [];
    const A = override ? Object.assign({}, ARM, override) : ARM;
    const H = b.heightMm, TWO_PI = 2 * Math.PI;
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const bicepC = +b.bicepMm > 0 ? +b.bicepMm : A.bicepFromBust * b.bustMm;
    const wristC = +b.wristMm > 0 ? +b.wristMm : A.wristFromBicep * bicepC;
    const ease = 1 - (A.sleeveEase || 0);                              // arm thinner than the sleeve's bicep
    const r0 = clamp((bicepC / TWO_PI) * ease, A.rMin, A.rMaxFrac * sh.a);   // radius = circumference/2π
    const r1 = clamp((wristC / TWO_PI) * ease, 12, r0);                      // tapers bicep → wrist
    const L = A.lenFrac * H, phi = (A.downDeg * Math.PI) / 180;
    const arms = [];
    for (const [side, sgn] of [["R", 1], ["L", -1]]) {
      const p0 = [sgn * (sh.a + r0 * A.socketOut), sh.y - A.socketDrop * H, 0];
      const dir = [sgn * Math.sin(phi), -Math.cos(phi), 0];            // down-and-out, z=0
      const p1 = [p0[0] + dir[0] * L, p0[1] + dir[1] * L, p0[2] + dir[2] * L];
      arms.push({ side, p0, p1, r0, r1 });   // render + collision share r0/r1 (no poke-through)
    }
    return arms;
  }

  // ── point-to-tapered-capsule (cylinder body + hemispherical caps via the t-clamp) ──
  // foot on the axis segment (clamped), the radial vector, and the local radius there.
  function capsuleFoot(arm, p) {
    const p0 = arm.p0, p1 = arm.p1;
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const L2 = ax * ax + ay * ay + az * az || 1;
    const wx = p[0] - p0[0], wy = p[1] - p0[1], wz = p[2] - p0[2];
    let t = (wx * ax + wy * ay + wz * az) / L2;
    if (t < 0) t = 0; else if (t > 1) t = 1;                 // clamp → hemispherical caps
    const fx = p0[0] + t * ax, fy = p0[1] + t * ay, fz = p0[2] + t * az;
    const rx = p[0] - fx, ry = p[1] - fy, rz = p[2] - fz;
    const rad = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const R = arm.r0 + (arm.r1 - arm.r0) * t;
    return { t, fx, fy, fz, rx, ry, rz, rad, R };
  }
  function signedDistCapsule(arm, p) { const f = capsuleFoot(arm, p); return f.rad - f.R; }
  function insideCapsule(arm, p) { return signedDistCapsule(arm, p) < 0; }
  // surface point + FULL-3D unit normal (the capsule normal genuinely tilts in y, unlike the
  // torso's horizontal-only normal). On-axis (rad≈0) picks a stable perpendicular to the axis.
  // ejectOutward: for a node trapped in the torso∩arm OVERLAP (armpit), a radial projection would
  // push it onto the arm's INNER (torso-facing) side → stuck inside the torso → ping-pong. Then we
  // eject it to the arm's OUTER side (⊥ axis, away from x=z=0) so the arm never pushes toward the
  // torso. Used ONLY in the overlap (nearestSurface decides), so the bulk sleeve isn't dragged out.
  function capsuleSurface(arm, p, skinMm, ejectOutward) {
    const skin = skinMm == null ? 4 : skinMm;
    const f = capsuleFoot(arm, p), Rs = f.R + skin;
    let nx, ny, nz;
    if (f.rad < 1e-9 || ejectOutward) {
      // outward direction at the foot, ⊥ axis (away from the body's vertical axis).
      const ax = arm.p1[0] - arm.p0[0], ay = arm.p1[1] - arm.p0[1], az = arm.p1[2] - arm.p0[2];
      const aL = Math.sqrt(ax * ax + ay * ay + az * az) || 1, dx = ax / aL, dy = ay / aL, dz = az / aL;
      let ox = f.fx, oz = f.fz;
      if (Math.abs(ox) < 1e-6 && Math.abs(oz) < 1e-6) { ox = arm.p0[0] >= 0 ? 1 : -1; oz = 0; }
      const od = ox * dx + oz * dz;
      nx = ox - od * dx; ny = -od * dy; nz = oz - od * dz;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      if (!ejectOutward && f.rad >= 1e-9) { nx = f.rx / f.rad; ny = f.ry / f.rad; nz = f.rz / f.rad; }
    } else { nx = f.rx / f.rad; ny = f.ry / f.rad; nz = f.rz / f.rad; }
    return { point: [f.fx + nx * Rs, f.fy + ny * Rs, f.fz + nz * Rs], normal: [nx, ny, nz], pushed: f.rad < f.R };
  }

  // ring (a,b) at height y by linear interpolation between bounding slices (clamped).
  function ringAt(stack, y) {
    const r = stack.rings, n = r.length;
    if (y <= r[0].y) return { a: r[0].a, b: r[0].b, cx: r[0].cx, cz: r[0].cz };
    if (y >= r[n - 1].y) return { a: r[n - 1].a, b: r[n - 1].b, cx: r[n - 1].cx, cz: r[n - 1].cz };
    let i = 0; while (i < n - 1 && r[i + 1].y < y) i++;
    const lo = r[i], hi = r[i + 1], f = (y - lo.y) / (hi.y - lo.y);
    return { a: lo.a + f * (hi.a - lo.a), b: lo.b + f * (hi.b - lo.b),
             cx: lo.cx + f * (hi.cx - lo.cx), cz: lo.cz + f * (hi.cz - lo.cz) };
  }

  // strictly inside the lofted ellipsoid-of-rings TORSO? (false above/below the form).
  function insideTorso(stack, p) {
    const y = p[1];
    if (y < stack.yMin || y > stack.yMax) return false;
    const r = ringAt(stack, y), dx = p[0] - r.cx, dz = p[2] - r.cz;
    return (dx * dx) / (r.a * r.a) + (dz * dz) / (r.b * r.b) < 1;
  }
  // Public: inside the TORSO ∪ (when present) any arm capsule. No-arms = byte-identical
  // (the loop is skipped, so this is exactly insideTorso).
  function insideForm(stack, p) {
    if (insideTorso(stack, p)) return true;
    if (stack.arms) for (const arm of stack.arms) if (insideCapsule(arm, p)) return true;
    return false;
  }

  // project a point radially onto the ring ellipse + a skin offset. Horizontal-only (the
  // returned point keeps p's height) so a body constraint never slides a node vertically and
  // unzips a seam. Returns { point, normal (outward, unit, y=0), pushed (was it inside?) }.
  function torsoSurface(stack, p, skinMm) {
    const skin = skinMm == null ? 4 : skinMm;
    const y = Math.max(stack.yMin, Math.min(stack.yMax, p[1]));
    const r = ringAt(stack, y);
    const A = r.a + skin, B = r.b + skin;
    let dx = p[0] - r.cx, dz = p[2] - r.cz;
    const pushed = insideTorso(stack, p);
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) {   // dead centre — push to +x by default
      return { point: [r.cx + A, y, r.cz], normal: [1, 0, 0], pushed: true };
    }
    // scale the radial so the point lands on the inflated (skin) ellipse boundary.
    const s = 1 / Math.sqrt((dx * dx) / (A * A) + (dz * dz) / (B * B));
    const px = r.cx + s * dx, pz = r.cz + s * dz;
    // outward ellipse normal at the projected point (gradient of (x/A)²+(z/B)²).
    let nx = (px - r.cx) / (A * A), nz = (pz - r.cz) / (B * B);
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    return { point: [px, y, pz], normal: [nx, 0, nz], pushed };
  }
  // Public: project an inside node OUT of the TORSO ∪ arms. No-arms = byte-identical (early
  // return). With arms: among the shapes the point is inside, prefer a projection that lands
  // OUTSIDE the whole union (a genuine one-step exit, smallest such move); else the deepest
  // push (and the per-substep loop in bodyProject finishes the job). Avoids the armpit ping-pong.
  function nearestSurface(stack, p, skinMm) {
    if (!stack.arms || !stack.arms.length) return torsoSurface(stack, p, skinMm);
    const cands = [];
    const dT = signedDistTorso(stack, p);
    if (dT < 0) cands.push({ s: torsoSurface(stack, p, skinMm), pen: -dT });
    for (const arm of stack.arms) {
      const dC = signedDistCapsule(arm, p);
      if (dC < 0) cands.push({ s: capsuleSurface(arm, p, skinMm), pen: -dC });   // radial (ejecting drags the sleeve off the armhole)
    }
    if (!cands.length) return torsoSurface(stack, p, skinMm);   // safety (caller gates on insideForm)
    let exit = null, deepest = cands[0];
    for (const c of cands) {
      if (c.pen > deepest.pen) deepest = c;
      if (!insideForm(stack, c.s.point) && (!exit || c.pen < exit.pen)) exit = c;
    }
    return (exit || deepest).s;
  }

  // approximate signed distance to the side wall (negative inside) — for a collision stiffness
  // ramp. Uses the ellipse-space radius scaled by the smaller semi-axis. Not exact, monotone.
  function signedDistTorso(stack, p) {
    const y = p[1];
    if (y < stack.yMin || y > stack.yMax) return Math.max(stack.yMin - y, y - stack.yMax);
    const r = ringAt(stack, y), dx = p[0] - r.cx, dz = p[2] - r.cz;
    const rad = Math.sqrt((dx * dx) / (r.a * r.a) + (dz * dz) / (r.b * r.b));
    return (rad - 1) * Math.min(r.a, r.b);
  }
  // Public: union SDF = min over the torso + arm capsules (negative inside). No-arms =
  // byte-identical. This is the metric the penetration test reads.
  function signedDist(stack, p) {
    let d = signedDistTorso(stack, p);
    if (stack.arms) for (const arm of stack.arms) { const dC = signedDistCapsule(arm, p); if (dC < d) d = dC; }
    return d;
  }

  // per-anchor-band circumference (Ramanujan-forward) — the test asserts these == the
  // measurements for k=1 bands (bust/waist/hip).
  function bandCircumferences(stack) {
    const k = ellipseK(stack.aspect);
    return stack.bands.map((bd) => ({ role: bd.role, circ: bd.a * k }));
  }

  window.BodyForm = {
    DEFAULT_BODY, ASPECT, PROFILE,
    ellipseK, semiAxesForCirc,
    loft, ringAt, insideForm, nearestSurface, signedDist, bandCircumferences,
  };
})();
