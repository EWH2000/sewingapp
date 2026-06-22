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

console.log("=== no overshoot, all rings sane, determinism ===");
let bad = 0; for (let i = 0; i <= 100; i++) { const rr = BF.ringAt(S, (S.yMax * i) / 100); if (!(rr.a > 0 && rr.b > 0) || rr.b / rr.a < 0.5 || rr.b / rr.a > 0.95) bad++; }
ok(bad === 0, `100 sampled rings all positive + b/a in a sane band (${bad} bad)`);
ok(JSON.stringify(BF.loft(D)) === JSON.stringify(BF.loft(D)), "loft is deterministic (deep-equal)");

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
  ok(Math.abs(box.min.y) < 1.0, `form seated on the floor (min.y ${box.min.y.toFixed(2)})`);
  ok(size.x > size.z, `bbox wider than deep (x ${size.x.toFixed(0)} > z ${size.z.toFixed(0)})`);
  ok(g.userData && g.userData.stack && BF.insideForm(g.userData.stack, [0, yB, 0]) === true,
     "group carries the collider stack (render + collision share one stack)");
} else if (P3) {
  ok(false, "preview3d.js exports dressFormGroup");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
