// verify-garment-drape.mjs — headless test for the M5c gravity garment drape (the deterministic
// parts; the LOOK + "doesn't explode on her real dress" are the owner gate). Pure: eval poly2tri,
// pattern-geom, body-form, pattern-fold, pattern-mesh, pattern-cloth into a window shim.
//
//   cd ~/sewingapp/tools/preview && node verify-garment-drape.mjs
//
// Checks: a garment (front+back bodice with place3d + body) drapes without NaN; the result hangs
// on the form (most settled nodes OUTSIDE the body, the pinned top stays up, the hem falls); body
// collision pushes an inside point out; determinism; geomHash re-keys on body/fabric but a BAG's
// hash is byte-identical to before (regression); degrade-never-blank.
import { readFileSync } from "node:fs";

global.window = {};
const APP = "/home/ehill/sewingapp/app/static/js";
for (const f of ["vendor/poly2tri.js", "pattern-geom.js", "body-form.js", "pattern-fold.js", "pattern-mesh.js", "pattern-cloth.js"])
  eval(readFileSync(`${APP}/${f}`, "utf8"));
const Cl = global.window.PatternCloth, BF = global.window.BodyForm;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };
const N = (x, y) => ({ x, y });
const finite = (nodes) => nodes.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]));

// A simple sleeveless bodice: front + back, shoulder + side seams, place3d + a default body.
const bodice = (id, name, role) => ({
  id, name, role: "panel", count: 1, seamMm: 12, closed: true, place3d: { role },
  nodes: [N(0, 0), N(260, 0), N(260, 230), N(240, 420), N(165, 400), N(95, 400), N(20, 420), N(0, 230)],
});
const front = bodice("bf", "Bodice Front", "front"), back = bodice("bb", "Bodice Back", "back");
const seams = [
  { a: { piece: "bf", edge: 3 }, b: { piece: "bb", edge: 3 } },  // R shoulder
  { a: { piece: "bf", edge: 5 }, b: { piece: "bb", edge: 5 } },  // L shoulder
  { a: { piece: "bf", edge: 1 }, b: { piece: "bb", edge: 7 } },  // R side
  { a: { piece: "bf", edge: 7 }, b: { piece: "bb", edge: 1 } },  // L side
];
const body = BF.DEFAULT_BODY;
const opts = { h: 25, garment: true, body };

console.log("=== garment drapes without NaN, on the form ===");
const r = Cl.solveDrape([front, back], seams, opts);
ok(r.nodes.length > 0 && r.tris.length > 0, `produced a mesh (${r.nodes.length} nodes, ${r.tris.length} tris)`);
ok(finite(r.nodes), "no NaN/Inf in the settled mesh");
ok(r.mode === "settled" || r.mode === "warm", `mode is settled/warm, not degraded (${r.mode})`);

console.log("=== it hangs ON the form (mostly outside the body; top up, hem down) ===");
const form = BF.loft(body);
const inside = r.nodes.filter((p) => BF.insideForm(form, p)).length;
ok(inside / r.nodes.length < 0.06, `≤6% of nodes inside the body — collision held (${inside}/${r.nodes.length})`);
const ys = r.nodes.map((p) => p[1]);
const topY = Math.max(...ys), botY = Math.min(...ys);
ok(topY > form.bands.find((b) => b.role === "waist").y, "the garment reaches up to the bust/shoulder band (pinned top stays up)");
ok(botY < topY - 100, `the hem falls well below the top (span ${(topY - botY).toFixed(0)}mm)`);
// nodes occupy BOTH front (+z) and back (−z) half — the panels wrapped to opposite sides
const zs = r.nodes.map((p) => p[2]);
ok(Math.max(...zs) > 20 && Math.min(...zs) < -20, "panels wrapped to front (+z) AND back (−z) of the form");

console.log("=== body collision pushes an inside point out ===");
const p0 = [0, form.bands.find((b) => b.role === "bust").y, 0];   // dead centre at bust height
ok(BF.insideForm(form, p0), "test point starts inside the body");
const s = BF.nearestSurface(form, p0, 6);
ok(!BF.insideForm(form, s.point), "nearestSurface projects it OUTSIDE the body");
ok(Math.abs(s.point[1] - p0[1]) < 1e-6, "the push is horizontal (height preserved — won't unzip seams)");

console.log("=== determinism ===");
const r2 = Cl.solveDrape([front, back], seams, opts);
let maxd = 0; for (let i = 0; i < r.nodes.length; i++) for (let d = 0; d < 3; d++) maxd = Math.max(maxd, Math.abs(r.nodes[i][d] - r2.nodes[i][d]));
ok(maxd < 1e-6, `two solves identical (max Δ ${maxd.toExponential(1)})`);

console.log("=== geomHash re-keys on body/fabric; a BAG's hash is unchanged (regression) ===");
const hCotton = Cl.geomHash([front, back], seams, { h: 25, garment: true, body, fabric: "cotton" });
const hDenim = Cl.geomHash([front, back], seams, { h: 25, garment: true, body, fabric: "denim" });
const hBigBust = Cl.geomHash([front, back], seams, { h: 25, garment: true, body: Object.assign({}, body, { bustMm: 1010 }), fabric: "cotton" });
ok(hCotton !== hDenim, "fabric change re-keys the hash");
ok(hCotton !== hBigBust, "a body (bust) change re-keys the hash");
// a plain bag (no garment/body/fabric) must hash identically with vs without the garment block present
const bag = [{ id: "p", name: "P", count: 1, nodes: [N(0, 0), N(200, 0), N(200, 200), N(0, 200)] }];
const bagSeams = [];
ok(Cl.geomHash(bag, bagSeams, { h: 20 }) === Cl.geomHash(bag, bagSeams, { h: 20 }), "bag hash deterministic + garment block skipped (byte-identical)");

console.log("=== a wedge dart sews shut + shapes the bodice front ===");
{
  const darted = Object.assign(bodice("bf", "Bodice Front", "front"),
    { darts: [{ id: "d_waist", edge: 0, center: 0.5, width: 26, depth: 120, kind: "wedge" }] });
  // the dart mesh cuts the wedge + tags both legs; selfSeamPairs pairs them. Triangulate at the
  // SAME h the drape uses (opts.h) so the pair node-indices line up with the solved mesh.
  const dm = global.window.PatternMesh.triangulatePiece(global.window.PatternGeom.normalizePieces({ pieces: [darted] })[0], opts.h);
  const leg0 = dm.boundaryMeta.filter((m) => m && m.dart === "d_waist" && m.leg === 0).length;
  const leg1 = dm.boundaryMeta.filter((m) => m && m.dart === "d_waist" && m.leg === 1).length;
  ok(leg0 > 0 && leg1 > 0, `dart legs tagged on the cut mesh (leg0=${leg0}, leg1=${leg1})`);
  const dpairs = global.window.PatternMesh.selfSeamPairs(dm, "d_waist");
  ok(dpairs.length > 0 && dpairs.every((p) => p[0] !== p[1]), `selfSeamPairs pairs the legs (${dpairs.length}, no self-pair)`);
  // drape darted vs flat — the dart closes (welded) and adds front-back depth (shaping)
  const rd = Cl.solveDrape([darted, back], seams, opts);
  const rf = Cl.solveDrape([front, back], seams, opts);
  const fr = rd.pieceRanges.find((p) => p.piece === "bf");
  let gap = 0; for (const pp of dpairs) { const i = fr.start + pp[0], j = fr.start + pp[1]; gap += Math.hypot(rd.nodes[i][0] - rd.nodes[j][0], rd.nodes[i][1] - rd.nodes[j][1], rd.nodes[i][2] - rd.nodes[j][2]); }
  ok(gap / dpairs.length < 8, `dart stays sewn shut under gravity (mean leg gap ${(gap / dpairs.length).toFixed(1)}mm — welded, not a spring)`);
  const depth = (r) => { const rr = r.pieceRanges.find((p) => p.piece === "bf"); let mn = 1e9, mx = -1e9; for (let i = rr.start; i < rr.start + rr.count; i++) { const z = r.nodes[i][2]; if (z < mn) mn = z; if (z > mx) mx = z; } return mx - mn; };
  ok(depth(rd) > depth(rf) + 30, `the dart shapes the front (z-depth ${depth(rd).toFixed(0)}mm darted > ${depth(rf).toFixed(0)}mm flat)`);
  ok(finite(rd.nodes), "darted drape has no NaN");
}

console.log("=== degrade-never-blank (garment, no seams → loose panels still drape) ===");
const rNoSeam = Cl.solveDrape([front, back], [], opts);
ok(rNoSeam.nodes.length > 0 && finite(rNoSeam.nodes), "a seamless garment still returns a finite mesh (no blank)");

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
