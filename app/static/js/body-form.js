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
  // the lofted region (hem→shoulder) as a fraction of stature. The form is a torso+upper-thigh
  // on the floor, not a full body; height scales this Y extent, girths stay put.
  const TORSO_FRAC = 0.52;
  const DEFAULT_BODY = { heightMm: 1650, bustMm: 920, waistMm: 740, hipMm: 980 };

  // Normalized silhouette, hem(yf=0) → shoulder(yf=1). `meas` ties a band to a measurement;
  // `k` scales that measurement's circumference (1.0 = exactly the measurement). Bands without a
  // direct measurement borrow the nearest governing one via k. The waist pinch + bust peak make
  // the torso read as a dress form rather than a tube.
  const PROFILE = [
    { yf: 0.00, role: "hem",       meas: "hipMm",   k: 0.92 },  // mid-thigh stop, just under hip
    { yf: 0.10, role: "thigh",     meas: "hipMm",   k: 0.98 },
    { yf: 0.22, role: "hip",       meas: "hipMm",   k: 1.00 },  // widest lower band
    { yf: 0.40, role: "waist",     meas: "waistMm", k: 1.00 },  // narrowest
    { yf: 0.55, role: "underbust", meas: "waistMm", k: 1.06 },
    { yf: 0.68, role: "bust",      meas: "bustMm",  k: 1.00 },  // bust peak
    { yf: 0.82, role: "chest",     meas: "bustMm",  k: 0.84 },  // above-bust, narrows
    { yf: 1.00, role: "shoulder",  meas: "bustMm",  k: 0.78 },  // shoulder band (no neck/arms)
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
  function loft(body, opts) {
    opts = opts || {};
    const b = fillBody(body);
    const aspect = opts.aspect || ASPECT;
    const profile = opts.profile || PROFILE;
    const yMax = b.heightMm * (opts.torsoFrac || TORSO_FRAC);
    // anchor rings: solve each band's semi-axis from its circumference, at its world height.
    const anchors = profile.map((band) => {
      const C = band.k * b[band.meas];
      return { y: band.yf * yMax, a: semiAxesForCirc(C, aspect).a, role: band.role };
    });
    const bands = anchors.map((an) => ({ y: an.y, role: an.role, a: an.a, b: aspect * an.a }));
    // resample to a smooth stack of `rings` slices (default 48) from hem to shoulder.
    const nRings = Math.max(8, opts.rings || 48);
    const rings = [];
    for (let i = 0; i < nRings; i++) {
      const y = (yMax * i) / (nRings - 1);
      const a = splineA(anchors, y);
      rings.push({ y: y, a: a, b: aspect * a, cx: 0, cz: 0 });
    }
    return { rings, yMin: 0, yMax, body: b, bands, aspect };
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

  // strictly inside the lofted ellipsoid-of-rings? (false above/below the form).
  function insideForm(stack, p) {
    const y = p[1];
    if (y < stack.yMin || y > stack.yMax) return false;
    const r = ringAt(stack, y), dx = p[0] - r.cx, dz = p[2] - r.cz;
    return (dx * dx) / (r.a * r.a) + (dz * dz) / (r.b * r.b) < 1;
  }

  // project a point radially onto the ring ellipse + a skin offset. Horizontal-only (the
  // returned point keeps p's height) so a body constraint never slides a node vertically and
  // unzips a seam. Returns { point, normal (outward, unit, y=0), pushed (was it inside?) }.
  function nearestSurface(stack, p, skinMm) {
    const skin = skinMm == null ? 4 : skinMm;
    const y = Math.max(stack.yMin, Math.min(stack.yMax, p[1]));
    const r = ringAt(stack, y);
    const A = r.a + skin, B = r.b + skin;
    let dx = p[0] - r.cx, dz = p[2] - r.cz;
    const pushed = insideForm(stack, p);
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

  // approximate signed distance to the side wall (negative inside) — for a collision stiffness
  // ramp. Uses the ellipse-space radius scaled by the smaller semi-axis. Not exact, monotone.
  function signedDist(stack, p) {
    const y = p[1];
    if (y < stack.yMin || y > stack.yMax) return Math.max(stack.yMin - y, y - stack.yMax);
    const r = ringAt(stack, y), dx = p[0] - r.cx, dz = p[2] - r.cz;
    const rad = Math.sqrt((dx * dx) / (r.a * r.a) + (dz * dz) / (r.b * r.b));
    return (rad - 1) * Math.min(r.a, r.b);
  }

  // per-anchor-band circumference (Ramanujan-forward) — the test asserts these == the
  // measurements for k=1 bands (bust/waist/hip).
  function bandCircumferences(stack) {
    const k = ellipseK(stack.aspect);
    return stack.bands.map((bd) => ({ role: bd.role, circ: bd.a * k }));
  }

  window.BodyForm = {
    DEFAULT_BODY, ASPECT, TORSO_FRAC, PROFILE,
    ellipseK, semiAxesForCirc,
    loft, ringAt, insideForm, nearestSurface, signedDist, bandCircumferences,
  };
})();
