// verify-body-form.mjs — headless test for the parametric dress form (app/static/js/body-form.js).
// Two sections: a PURE section (eval the module, no resolver — like verify-cloth.mjs) and a RENDER
// section (resolver + import preview3d.js — like verify-fold-mesh.mjs) that checks dressFormGroup.
//
//   cd ~/sewingapp/tools/preview && node verify-body-form.mjs
//
// Pure: ring circumferences match the measurements (Ramanujan); aspect honored; height scales Y
// but leaves girths put; insideForm true/false incl. the aspect-asymmetry check (catches an a/b
// swap); nearestSurface projects horizontally + outward; re-loft on a measurement change; no
// Catmull-Rom overshoot; determinism. Render: one translucent dressform mesh, seated on floor,
// bbox wider-than-deep, shares the collider stack.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const APP = "/home/ehill/sewingapp/app/static/js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ── PURE section ────────────────────────────────────────────────────────────────
global.window = {};
eval(readFileSync(`${APP}/body-form.js`, "utf8"));   // → window.BodyForm
const BF = global.window.BodyForm;
const D = BF.DEFAULT_BODY;                            // 1650/920/740/980
const S = BF.loft(D);
const band = (role) => S.bands.find((b) => b.role === role);
const circOf = (role) => BF.bandCircumferences(S).find((c) => c.role === role).circ;

console.log("=== ring circumferences match the measurements (Ramanujan) ===");
ok(approx(circOf("bust"), 920, 1), `bust band circ ≈ 920 (${circOf("bust").toFixed(1)})`);
ok(approx(circOf("waist"), 740, 1), `waist band circ ≈ 740 (${circOf("waist").toFixed(1)})`);
ok(approx(circOf("hip"), 980, 1), `hip band circ ≈ 980 (${circOf("hip").toFixed(1)})`);

console.log("=== aspect honored (wider than deep) at every band ===");
ok(S.bands.every((b) => approx(b.b / b.a, BF.ASPECT, 1e-9)), `every band b/a = ASPECT ${BF.ASPECT}`);
ok(S.bands.every((b) => b.a > b.b), "every band wider (a) than deep (b)");

console.log("=== height scales Y, leaves girths put ===");
const S2 = BF.loft(Object.assign({}, D, { heightMm: 1980 }));   // 1.2×
ok(approx(S2.yMax / S.yMax, 1.2, 1e-6), `yMax scales 1.2× (${(S2.yMax / S.yMax).toFixed(4)})`);
const circ2 = (role) => BF.bandCircumferences(S2).find((c) => c.role === role).circ;
ok(approx(circ2("bust"), 920, 1) && approx(circ2("waist"), 740, 1) && approx(circ2("hip"), 980, 1),
   "bust/waist/hip circumferences unchanged when only height changes");

console.log("=== insideForm on known points (+ aspect-asymmetry) ===");
const yB = band("bust").y, aB = band("bust").a, bB = band("bust").b;
ok(BF.insideForm(S, [0, yB, 0]) === true, "centre at bust height is inside");
ok(BF.insideForm(S, [aB * 0.9, yB, 0]) === true, "0.9·a along width (x) is inside");
ok(BF.insideForm(S, [0, yB, aB * 0.9]) === false, "SAME distance along depth (z) is OUTSIDE (b<a) — no a/b swap");
ok(BF.insideForm(S, [aB + 30, yB, 0]) === false, "30mm past the side surface is outside");
ok(BF.insideForm(S, [0, S.yMax + 50, 0]) === false, "above the shoulder is outside");
ok(BF.insideForm(S, [0, -10, 0]) === false, "below the hem is outside");
ok(BF.insideForm(S, [aB, yB, 0]) === false, "exactly on the boundary is not strictly inside");

console.log("=== nearestSurface projects horizontally + outward ===");
const r = BF.nearestSurface(S, [10, yB, 5], 4);
ok(r.pushed === true, "an inside point reports pushed");
ok(approx(r.point[1], yB, 1e-9), "projection keeps the node's height (horizontal-only)");
ok((r.point[0] / (aB)) ** 2 + (r.point[2] / (bB)) ** 2 >= 1, "projected point is on/outside the bare ellipse");
ok(approx(Math.hypot(r.normal[0], r.normal[2]), 1, 1e-6) && r.normal[1] === 0, "normal is unit + horizontal");
ok(r.normal[0] * r.point[0] + r.normal[2] * r.point[2] > 0, "normal points outward");
const out = BF.nearestSurface(S, [aB + 100, yB, 0], 4);
ok(out.pushed === false, "an already-outside point is not flagged pushed");

console.log("=== re-loft on a measurement change is correct ===");
const Sw = BF.loft(Object.assign({}, D, { waistMm: 820 }));
ok(approx(BF.bandCircumferences(Sw).find((c) => c.role === "waist").circ, 820, 1), "waist band re-lofts to 820");
ok(band("waist").a < Sw.bands.find((b) => b.role === "waist").a, "bigger waist → bigger semi-axis");
ok(approx(BF.bandCircumferences(Sw).find((c) => c.role === "bust").circ, 920, 1), "bust band unchanged by a waist edit");

console.log("=== form floats at anatomical height (room for a skirt below the waist) ===");
ok(S.yMin > 0.35 * D.heightMm && S.yMin < 0.5 * D.heightMm, `hem floats at ~0.42·height (${S.yMin.toFixed(0)}mm)`);
ok(S.yMax > 0.86 * D.heightMm && S.yMax < 0.91 * D.heightMm, `yMax now at the neck-top (~0.89·height) (${S.yMax.toFixed(0)}mm)`);
ok(band("waist").y < band("bust").y && band("hip").y < band("waist").y, "hip < waist < bust in height (anatomical order)");

console.log("=== M6: the form has real SHOULDERS + a NECK (so a bodice top can drape over a surface) ===");
ok(band("shoulder").y > 0.80 * D.heightMm && band("shoulder").y < 0.84 * D.heightMm, `shoulder (acromion) at ~0.82·height (${band("shoulder").y.toFixed(0)}mm)`);
ok(band("neck") && band("neck").y > band("shoulder").y, "a neck band sits ABOVE the shoulder");
ok(approx(BF.bandCircumferences(S).find((c) => c.role === "neck").circ, 0.5 * D.bustMm, 1), `neck band ≈ ½ bust (${BF.bandCircumferences(S).find((c) => c.role === "neck").circ.toFixed(0)}mm)`);
ok(approx(S.yMax, band("neck_top").y, 1e-6) && band("neck_top").y > band("neck").y, "yMax is the neck-top, above the neck");
{ let mono = true, prev = Infinity; for (let i = 0; i <= 20; i++) { const y = band("shoulder").y + (band("neck").y - band("shoulder").y) * i / 20; const a = BF.ringAt(S, y).a; if (a > prev + 1e-9) mono = false; prev = a; } ok(mono, "the shoulder→neck slope tapers monotonically (no spike)"); }
ok(band("bust").a > band("shoulder").a && band("shoulder").a > band("neck").a, "bust > shoulder > neck in width (the slope narrows up)");

console.log("=== no overshoot, all rings sane, determinism ===");
let bad = 0; for (let i = 0; i <= 100; i++) { const rr = BF.ringAt(S, S.yMin + ((S.yMax - S.yMin) * i) / 100); if (!(rr.a > 0 && rr.b > 0) || rr.b / rr.a < 0.5 || rr.b / rr.a > 0.95) bad++; }
ok(bad === 0, `100 sampled rings all positive + b/a in a sane band (${bad} bad)`);
ok(JSON.stringify(BF.loft(D)) === JSON.stringify(BF.loft(D)), "loft is deterministic (deep-equal)");

console.log("=== Stage B2: arm generation (opts.arms) + capsule collision ===");
ok(BF.loft(D).arms === undefined, "no arms key without opts.arms (no-arms loft byte-identical)");
const SA = BF.loft(D, { arms: true });
ok(Array.isArray(SA.arms) && SA.arms.length === 2, "two arms when requested");
const AR = SA.arms.find((a) => a.side === "R"), AL = SA.arms.find((a) => a.side === "L");
ok(AR && AL && AR.p0[0] > 0 && AL.p0[0] < 0, "R arm on +x, L arm on −x");
ok(AR.p1[1] < AR.p0[1], "arm hangs DOWN (wrist below the socket)");
ok(AR.p0[1] < band("neck").y && approx(AR.p0[1], band("shoulder").y - 0.02 * D.heightMm, 1e-6), "arm sockets at the SHOULDER band, not the neck (M6: shoulder is no longer the top)");
ok(AR.r0 > AR.r1, "arm tapers bicep → wrist");
const rawBicepR = (D.bustMm * 0.32) / (2 * Math.PI);                          // ≈47mm before sleeve ease
ok(AR.r0 > 0.7 * rawBicepR && AR.r0 < rawBicepR, `r0 ≈ bicep/2π, thinner by sleeve ease (${AR.r0.toFixed(1)}mm vs raw ${rawBicepR.toFixed(1)})`);
ok(JSON.stringify(BF.loft(D, { arms: true })) === JSON.stringify(BF.loft(D, { arms: true })), "armed loft is deterministic");
const mid = [(AR.p0[0] + AR.p1[0]) / 2, (AR.p0[1] + AR.p1[1]) / 2, 0];
ok(BF.insideForm(SA, mid) === true, "arm axis midpoint is inside the form (union)");
ok(BF.insideForm(BF.loft(D), mid) === false, "...and OUTSIDE the torso-only form (it's the arm, not the torso)");
const cs = BF.nearestSurface(SA, mid, 6);
ok(approx(Math.hypot(cs.normal[0], cs.normal[1], cs.normal[2]), 1, 1e-6), "capsule normal is unit");
ok(cs.normal[1] !== 0, "capsule normal is FULL-3D (tilts in y, unlike the horizontal torso normal)");
ok(BF.insideForm(SA, cs.point) === false, "capsule projection lands outside the form");
ok(BF.signedDist(SA, mid) < 0 && BF.signedDist(SA, mid) <= BF.signedDist(BF.loft(D), mid) + 1e-9, "union signedDist = min(torso, arms)");
ok(Number.isFinite(BF.nearestSurface(SA, [AR.p0[0], AR.p0[1] - 1, 0], 6).point[0]), "near-axis point handled (no NaN)");
const tp = [10, band("bust").y, 5];   // a torso-interior point, far from any arm
ok(JSON.stringify(BF.nearestSurface(BF.loft(D), tp, 6)) === JSON.stringify(BF.nearestSurface(SA, tp, 6)),
   "arms don't perturb a torso-only projection (byte-identical torso path)");

console.log("=== M6 armhole polish: arm ABDUCTION clears the torso below the socket ===");
// At the old 12° the arm's inner wall overlapped the torso wall ~14mm for ~140mm below the
// socket — an unclosable geometric bind for the sleeve underarm (it tore the seam open). At the
// new default the free shaft clears the torso; only the anatomical shoulder joint overlaps.
{
  const yq = AR.p0[1] - 130;                                  // underarm-junction height
  const dirY = (AR.p1[1] - AR.p0[1]);
  const t = (yq - AR.p0[1]) / dirY;
  const ax = AR.p0[0] + t * (AR.p1[0] - AR.p0[0]);
  const Rq = AR.r0 + (AR.r1 - AR.r0) * t;
  const ring = BF.ringAt(SA, yq);
  ok(ax - Rq > ring.a, `arm inner wall clears the torso at the underarm junction (${(ax - Rq - ring.a).toFixed(1)}mm gap at y=socket−130)`);
}

console.log("=== M6 armhole polish: smooth-union (fillet) collision field ===");
{
  const K = 25;
  // fillet ⊆: smin ≤ min everywhere, so the d=0 isosurface lies ON or OUTSIDE the true union —
  // cloth resting on it can never be inside the real form.
  const probes = [[175, 1210, -4], [165, 1250, 0], [172, AR.p0[1], 0], [230, 1100, 20], [10, band("bust").y, 5], [400, 1200, 0]];
  ok(probes.every((p) => BF.smoothField(SA, p, K).d <= BF.signedDist(SA, p) + 1e-9), "smoothField ≤ true-union signedDist everywhere (fillet only bulges outward)");
  // far from any crease the field IS the hard union
  ok(Math.abs(BF.smoothField(SA, [400, 1200, 0], K).d - BF.signedDist(SA, [400, 1200, 0])) < 1e-9, "far from the crease the smooth field equals the hard union");
  // projection: a grid across the armpit wedge exits the TRUE union (the old hard-union
  // projection had no exit there — the measured 17-21mm clipping). Mirrors the solver's usage:
  // repeated BOUNDED calls (one per substep) — assert convergence within a modest call budget.
  let worstTrue = Infinity, worse = 0;
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) for (let m = 0; m < 5; m++) {
    let p = [148 + i * 6, 1180 + j * 20, -40 + m * 20];
    const d0 = BF.signedDist(SA, p);
    for (let it = 0; it < 20; it++) {
      if (BF.smoothField(SA, p, K).d >= 0) break;
      p = BF.smoothSurface(SA, p, K, 6, 3, 15).point;        // bounded, like bodyProject
    }
    const dT = BF.signedDist(SA, p);
    if (dT < worstTrue) worstTrue = dT;
    if (dT < d0 - 1e-6) worse++;
  }
  ok(worstTrue > -1, `wedge-grid projection exits the true union under repeated bounded calls (worst residual ${worstTrue.toFixed(2)}mm)`);
  ok(worse === 0, "projection never leaves a point worse than it started (safeguarded Newton + monotone escapes)");
  // noEscape (seam nodes): never worsens the field, never teleports across the watershed
  const pw = [165, 1250, 0];
  const sn = BF.smoothSurface(SA, pw, K, 6, 3, 0, true);
  ok(BF.smoothField(SA, sn.point, K).d >= BF.smoothField(SA, pw, K).d - 1e-9, "noEscape projection never lowers the field");
  ok(Math.hypot(sn.point[2] - pw[2]) < 25, "noEscape stays near its start (no fold teleport for seam nodes)");
  // bounded step: total displacement capped
  const sb = BF.smoothSurface(SA, [175, 1210, -4], K, 6, 3, 10);
  ok(Math.hypot(sb.point[0] - 175, sb.point[1] - 1210, sb.point[2] + 4) <= 10 + 1e-9, "maxStepMm caps the per-call displacement");
  ok(JSON.stringify(BF.smoothSurface(SA, [170, 1239, -12], K, 6, 3)) === JSON.stringify(BF.smoothSurface(SA, [170, 1239, -12], K, 6, 3)), "smoothSurface is deterministic");
}

// ── RENDER section (resolver + preview3d.js) ──────────────────────────────────────
console.log("=== dressFormGroup render (three.js) ===");
let THREE, P3;
try {
  register("./three-resolver.mjs", pathToFileURL("./"));
  THREE = await import("three");
  // preview3d.js reads window.BodyForm — already eval'd above into global.window.
  P3 = await import(pathToFileURL(`${APP}/preview3d.js`).href);
} catch (e) {
  console.log("  (skipped render section — three resolver unavailable:", e.message, ")");
}
if (P3 && P3.dressFormGroup) {
  const g = P3.dressFormGroup(D);
  ok(g && g.isObject3D, "dressFormGroup returns an Object3D");
  let mesh = null; g.traverse((o) => { if (o.userData && o.userData.kind === "dressform") mesh = o; });
  ok(!!mesh, "contains a dressform mesh");
  ok(mesh && mesh.material && mesh.material.transparent && mesh.material.opacity < 1, "material is translucent");
  const box = new THREE.Box3().setFromObject(g), size = new THREE.Vector3(); box.getSize(size);
  ok(Math.abs(box.min.y - S.yMin) < 1.0, `form floats at the hem band (min.y ${box.min.y.toFixed(0)} ≈ yMin ${S.yMin.toFixed(0)})`);
  ok(size.x > size.z, `bbox wider than deep (x ${size.x.toFixed(0)} > z ${size.z.toFixed(0)})`);
  ok(g.userData && g.userData.stack && BF.insideForm(g.userData.stack, [0, yB, 0]) === true,
     "group carries the collider stack (render + collision share one stack)");
  // Stage B2: arms render as extra meshes only when requested; no-arms render unchanged.
  let g0arms = 0; g.traverse((o) => { if (o.userData && o.userData.kind === "dressform-arm") g0arms++; });
  ok(g0arms === 0, "no-arms render adds ZERO arm meshes (byte-identical mesh set)");
  const ga = P3.dressFormGroup(D, { arms: true });
  let torsoM = 0, armM = 0; ga.traverse((o) => { if (o.userData) { if (o.userData.kind === "dressform") torsoM++; if (o.userData.kind === "dressform-arm") armM++; } });
  ok(torsoM === 1 && armM === 2, `arms render: 1 torso + 2 arm meshes (got ${torsoM}+${armM})`);
  ok(ga.userData.stack && ga.userData.stack.arms && ga.userData.stack.arms.length === 2,
     "render group carries the arm stack (renderer + collider share the same arms)");
} else if (P3) {
  ok(false, "preview3d.js exports dressFormGroup");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
