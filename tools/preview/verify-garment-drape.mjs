// verify-garment-drape.mjs — headless test for the M5c gravity garment drape (the deterministic
// parts; the LOOK + "doesn't explode on her real dress" are the owner gate). Pure: eval poly2tri,
// pattern-geom, body-form, pattern-fold, pattern-mesh, pattern-cloth into a window shim.
//
//   cd ~/sewingapp/tools/preview && node verify-garment-drape.mjs
//
// Checks: a (correctly-sized) garment drapes without NaN; it hangs on the form; the shoulder + side
// seams CLOSE (the M5c-step3 pin-fix: stitch-up unpinned so the top seam — which sits in the pinned
// band — actually sews; bodice pinned at the waist too so it doesn't droop to the wider hip); the
// fit-strain metric is quiet on a fitting garment and FIRES (bounded) on an oversized body; body
// collision; determinism; geomHash regression; dart welds; degrade-never-blank.
import { readFileSync } from "node:fs";

global.window = {};
const APP = "/home/ehill/sewingapp/app/static/js";
for (const f of ["vendor/poly2tri.js", "pattern-geom.js", "body-form.js", "pattern-fold.js", "pattern-mesh.js", "pattern-cloth.js"])
  eval(readFileSync(`${APP}/${f}`, "utf8"));
const Cl = global.window.PatternCloth, BF = global.window.BodyForm;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };
const N = (x, y) => ({ x, y });
const curve = (cp) => ({ curve: { type: "quad", cp } });
const finite = (nodes) => nodes.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]));

// A correctly-sized sleeveless bodice (mirrors tools/seed-examples.mjs): symmetric taper, waist 390 +
// bust 490 per panel → front+back waist 780 / bust 980 (fits the default body), curved neck+armholes.
const bodice = (id, name, role, neckDip, dart) => {
  const p = {
    id, name, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes: [N(50, 0), N(440, 0), N(490, 230), N(452, 420), N(311, 400), N(179, 400), N(38, 420), N(0, 230)],
    edges: { "2": curve([0.5, 0.16]), "4": curve([0.5, neckDip]), "6": curve([0.5, 0.16]) },
  };
  if (dart) p.darts = [{ id: "d_waist", edge: 0, center: 0.5, width: 26, depth: 120, kind: "wedge" }];
  return p;
};
const front = bodice("bf", "Bodice Front", "front", 0.28, false);
const back = bodice("bb", "Bodice Back", "back", 0.10, false);
// shoulders CROSS (front-R ↔ back-L) like the sides, because the back wraps mirror-image.
const seams = [
  { a: { piece: "bf", edge: 3 }, b: { piece: "bb", edge: 5 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] },  // R shoulder
  { a: { piece: "bf", edge: 5 }, b: { piece: "bb", edge: 3 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] },  // L shoulder
  { a: { piece: "bf", edge: 1 }, b: { piece: "bb", edge: 7 } },  // R side
  { a: { piece: "bf", edge: 7 }, b: { piece: "bb", edge: 1 } },  // L side
];
const body = BF.DEFAULT_BODY;
const opts = { h: 20, garment: true, body };   // Standard detail (the default the owner gates on)

// helper: split inter-piece seam residuals into shoulder-band (top) vs side (lower) by node height.
function seamResiduals(r) {
  const np = new Array(r.nodes.length).fill("?");
  r.pieceRanges.forEach((pr) => { for (let k = 0; k < pr.count; k++) np[pr.start + k] = pr.piece; });
  let shoulder = 0, side = 0;
  for (const [i, j] of r.seamLinks || []) {
    if (np[i] === np[j]) continue;                         // dart weld — not an inter-piece seam
    const a = r.nodes[i], b = r.nodes[j], d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (a[1] > 1300 || b[1] > 1300) shoulder = Math.max(shoulder, d); else side = Math.max(side, d);
  }
  return { shoulder, side };
}

console.log("=== garment drapes without NaN, on the form ===");
const r = Cl.solveDrape([front, back], seams, opts);
ok(r.nodes.length > 0 && r.tris.length > 0, `produced a mesh (${r.nodes.length} nodes, ${r.tris.length} tris)`);
ok(finite(r.nodes), "no NaN/Inf in the settled mesh");
ok(r.mode === "settled" || r.mode === "warm", `mode is settled/warm, not degraded (${r.mode})`);

console.log("=== the shoulder + side seams CLOSE (pin-fix regression) ===");
const res = seamResiduals(r);
ok(res.shoulder < 15, `shoulder seam closes (max residual ${res.shoulder.toFixed(1)}mm — was ~175mm with the pinned-band bug)`);
ok(res.side < 15, `side seam closes (max residual ${res.side.toFixed(1)}mm)`);
// the rollback flag reproduces the bug (pinned-band freezes the shoulder open) — proves WHAT fixed it
const rOld = Cl.solveDrape([front, back], seams, Object.assign({}, opts, { stitchUnpinned: false }));
ok(seamResiduals(rOld).shoulder > 60, `stitchUnpinned:false regresses the shoulder (${seamResiduals(rOld).shoulder.toFixed(0)}mm) — the unpinned stitch-up is what closes it`);

console.log("=== the fit-strain metric is present + QUIET on a fitting garment ===");
ok(r.strain && typeof r.strain.overTension === "boolean", "strain object present on the garment result");
ok(r.strain.overTension === false, `a fitting garment does NOT warn (maxGap ${r.strain.maxSeamGapMm.toFixed(1)}mm < threshold)`);
ok(Array.isArray(r.strain.gapSegs) && r.strain.gapSegs.length === 0, "no gap-highlight segments when it fits");

console.log("=== it hangs ON the form (hugs the surface, doesn't poke deep; top up, hem down) ===");
const form = BF.loft(body);
// a FITTED bodice sits ON the body, so many nodes are at the surface — the meaningful check is that
// none pokes DEEP through it (the collision skin is 6mm; allow up to ~2× before it reads as clipping).
const maxPen = r.nodes.reduce((m, p) => Math.max(m, -Math.min(0, BF.signedDist(form, p))), 0);
ok(maxPen < 14, `cloth hugs the surface without poking deep into the body (max penetration ${maxPen.toFixed(1)}mm)`);
const ys = r.nodes.map((p) => p[1]);
const topY = Math.max(...ys), botY = Math.min(...ys);
ok(topY > form.bands.find((b) => b.role === "waist").y, "the garment reaches up to the bust/shoulder band (pinned top stays up)");
ok(botY < topY - 100, `the hem falls well below the top (span ${(topY - botY).toFixed(0)}mm)`);
const zs = r.nodes.map((p) => p[2]);
ok(Math.max(...zs) > 20 && Math.min(...zs) < -20, "panels wrapped to front (+z) AND back (−z) of the form");

console.log("=== the warning FIRES (bounded) when the body outgrows the garment ===");
const rBig = Cl.solveDrape([front, back], seams, Object.assign({}, opts, { body: Object.assign({}, body, { bustMm: 1400, waistMm: 1200 }) }));
ok(finite(rBig.nodes), "oversized-body drape still finite (no explosion)");
ok(rBig.strain.overTension === true && rBig.strain.wontClose === true, `oversized body warns (maxGap ${rBig.strain.maxSeamGapMm.toFixed(0)}mm, wontClose)`);
ok(rBig.strain.gapSegs.length > 0, "the over-tension drape carries gap-highlight segments");
// the stretch ceiling is a soft (Gauss–Seidel) bound: a modest misfit stays near 1.15, but a wildly
// oversized body (here +50%) still gaps AND stretches near the gap — the point is it doesn't EXPLODE.
ok(rBig.strain.maxStretchRatio < 4, `stretch stayed bounded — no explosion (p95 ${rBig.strain.maxStretchRatio.toFixed(2)})`);

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
const bag = [{ id: "p", name: "P", count: 1, nodes: [N(0, 0), N(200, 0), N(200, 200), N(0, 200)] }];
ok(Cl.geomHash(bag, [], { h: 20 }) === Cl.geomHash(bag, [], { h: 20 }), "bag hash deterministic + garment block skipped (byte-identical)");

console.log("=== a wedge dart sews shut + shapes the bodice front (and is excluded from seam strain) ===");
{
  const darted = bodice("bf", "Bodice Front", "front", 0.28, true);
  const dm = global.window.PatternMesh.triangulatePiece(global.window.PatternGeom.normalizePieces({ pieces: [darted] })[0], opts.h);
  const leg0 = dm.boundaryMeta.filter((m) => m && m.dart === "d_waist" && m.leg === 0).length;
  const leg1 = dm.boundaryMeta.filter((m) => m && m.dart === "d_waist" && m.leg === 1).length;
  ok(leg0 > 0 && leg1 > 0, `dart legs tagged on the cut mesh (leg0=${leg0}, leg1=${leg1})`);
  const dpairs = global.window.PatternMesh.selfSeamPairs(dm, "d_waist");
  ok(dpairs.length > 0 && dpairs.every((p) => p[0] !== p[1]), `selfSeamPairs pairs the legs (${dpairs.length}, no self-pair)`);
  const rd = Cl.solveDrape([darted, back], seams, opts);
  const fr = rd.pieceRanges.find((p) => p.piece === "bf");
  let gap = 0; for (const pp of dpairs) { const i = fr.start + pp[0], j = fr.start + pp[1]; gap += Math.hypot(rd.nodes[i][0] - rd.nodes[j][0], rd.nodes[i][1] - rd.nodes[j][1], rd.nodes[i][2] - rd.nodes[j][2]); }
  // the weld pulls the legs together (vs the 26mm authored mouth) so the dart reads sewn, not gaping.
  // On a FITTED bodice the body provides the bust shape, so the dart's job here is waist suppression +
  // a clean closure rather than the big front-back depth it added on the old loose (undersized) panel.
  ok(gap / dpairs.length < 15, `dart sews mostly shut under gravity (mean leg gap ${(gap / dpairs.length).toFixed(1)}mm < the 26mm authored mouth)`);
  ok(finite(rd.nodes), "darted drape has no NaN");
  // the dart is a same-piece WELD — it must NOT appear as an inter-piece seam in the strain metric
  ok((rd.strain.seams || []).every((sm) => sm.seam !== "d_waist"), "dart weld is excluded from the seam-strain list (inter-piece seams only)");
}

console.log("=== a skirt (top-pinned, hem free) still drapes finite — unpinned-stitch-up didn't break it ===");
{
  const sk = (id, role) => ({ id, name: id, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes: [N(0, 0), N(760, 0), N(575, 560), N(185, 560)] });   // hem 760, waist 390 (A-line)
  const skf = sk("skf", "front-skirt"), skb = sk("skb", "back-skirt");
  const skSeams = [{ a: { piece: "skf", edge: 1 }, b: { piece: "skb", edge: 3 } }, { a: { piece: "skf", edge: 3 }, b: { piece: "skb", edge: 1 } }];
  const rs = Cl.solveDrape([skf, skb], skSeams, opts);
  ok(finite(rs.nodes) && rs.nodes.length > 0, "skirt drapes finite");
  ok(rs.mode !== "degraded", `skirt not degraded (${rs.mode})`);
  const sy = rs.nodes.map((p) => p[1]);
  ok(Math.min(...sy) < form.bands.find((b) => b.role === "waist").y, "skirt hangs below the waist");
}

console.log("=== degrade-never-blank (garment, no seams → loose panels still drape) ===");
const rNoSeam = Cl.solveDrape([front, back], [], opts);
ok(rNoSeam.nodes.length > 0 && finite(rNoSeam.nodes), "a seamless garment still returns a finite mesh (no blank)");

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
