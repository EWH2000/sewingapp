// verify-cloth.mjs — headless test for the XPBD cloth solver (app/static/js/pattern-cloth.js).
//
// Pure (no three.js), so like verify-mesh.mjs it needs no module resolver: shim global.window,
// eval the vendored poly2tri + pattern-geom + pattern-fold + pattern-mesh + pattern-cloth, then
// drape the worked boxy tote and assert the deterministic, no-visual-oracle properties: the
// warm-start assembly is well-formed, nothing goes NaN, the seams close, the bag inflates
// (girth up vs no-pressure), the result is reproducible, and it never blanks/throws.
//
//   cd ~/sewingapp/tools/preview && node verify-cloth.mjs
//
// The drape *look* and "doesn't explode on her real tote" are NOT auto-testable — that's the
// owner's hands-on gate. This guards the math underneath it.
import { readFileSync } from "node:fs";

global.window = {};
const APP = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${APP}/vendor/poly2tri.js`, "utf8"));   // → window.poly2tri
eval(readFileSync(`${APP}/pattern-geom.js`, "utf8"));      // → window.PatternGeom
eval(readFileSync(`${APP}/pattern-fold.js`, "utf8"));      // → window.PatternFold
eval(readFileSync(`${APP}/pattern-mesh.js`, "utf8"));      // → window.PatternMesh
eval(readFileSync(`${APP}/pattern-cloth.js`, "utf8"));     // → window.PatternCloth
const F = global.window.PatternFold;
const M = global.window.PatternMesh;
const Cl = global.window.PatternCloth;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };

// ── place a local node by a fold transform (to check the warm start) ──
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function qrot(q, v) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const applyT = (T, v) => add(T.pos, qrot(T.quat, v));
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const finite = (v) => Number.isFinite(v);
const allFinite = (res) => res.nodes.every((n) => finite(n[0]) && finite(n[1]) && finite(n[2]));
const bboxDims = (res) => {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const n of res.nodes) for (let d = 0; d < 3; d++) { if (n[d] < lo[d]) lo[d] = n[d]; if (n[d] > hi[d]) hi[d] = n[d]; }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
};
const maxSeamGap = (res) => res.seamLinks.reduce((m, [i, j]) => Math.max(m, dist3(res.nodes[i], res.nodes[j])), 0);
// horizontal "girth" proxy: Σ radial distance from the vertical axis through the centroid.
function girth(res) {
  let cx = 0, cz = 0; for (const n of res.nodes) { cx += n[0]; cz += n[2]; }
  cx /= res.nodes.length; cz /= res.nodes.length;
  let g = 0; for (const n of res.nodes) g += Math.hypot(n[0] - cx, n[2] - cz);
  return g;
}

// ── the worked boxy tote (verbatim from verify-fold.mjs Fixture C) ──
const rect = (id, name, w, h) => ({ id, name, count: 1, seamMm: 0, cornerRadius: 0, closed: true,
  nodes: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] });
function tote() {
  const pieces = [
    rect("p_base", "Base", 300, 120), rect("p_front", "Front", 300, 250), rect("p_back", "Back", 300, 250),
    rect("p_sideL", "Side L", 120, 250), rect("p_sideR", "Side R", 120, 250),
  ];
  const seams = [
    { id: "s_bf", a: { piece: "p_base", edge: 0 }, b: { piece: "p_front", edge: 0 }, foldAngle: 90 },
    { id: "s_bb", a: { piece: "p_base", edge: 2 }, b: { piece: "p_back", edge: 0 }, foldAngle: 90 },
    { id: "s_bl", a: { piece: "p_base", edge: 3 }, b: { piece: "p_sideL", edge: 0 }, foldAngle: 90 },
    { id: "s_br", a: { piece: "p_base", edge: 1 }, b: { piece: "p_sideR", edge: 0 }, foldAngle: 90 },
    { id: "s_fl", a: { piece: "p_front", edge: 3 }, b: { piece: "p_sideL", edge: 3 }, foldAngle: null },
    { id: "s_fr", a: { piece: "p_front", edge: 1 }, b: { piece: "p_sideR", edge: 1 }, foldAngle: null },
    { id: "s_back_l", a: { piece: "p_back", edge: 3 }, b: { piece: "p_sideL", edge: 1 }, foldAngle: null },
    { id: "s_back_r", a: { piece: "p_back", edge: 1 }, b: { piece: "p_sideR", edge: 3 }, foldAngle: null },
  ];
  return { pieces, seams };
}

const H = 25;   // coarse spacing → fast test (~490 nodes)

console.log("=== A. Assembly / warm start (no solve) ===");
{
  const { pieces, seams } = tote();
  const res = Cl.solveDrape(pieces, seams, { h: H, maxStitch: 0, maxSettle: 0 });
  // expected node total = Σ per-piece mesh node counts (no straps in this fixture)
  let expected = 0;
  for (const p of pieces) expected += M.triangulatePiece(p, H).nodes.length;
  ok(res.nodes.length === expected, `node total = Σ per-piece mesh nodes (${res.nodes.length} vs ${expected})`);
  ok(res.pieceRanges.length === 5, `5 pieceRanges (straps none), got ${res.pieceRanges.length}`);
  // ranges tile [0,N) with no gaps/overlaps
  let cursor = 0, tiled = true;
  for (const pr of res.pieceRanges) { if (pr.start !== cursor) tiled = false; cursor += pr.count; }
  ok(tiled && cursor === res.nodes.length, "pieceRanges tile [0,N) with no gaps/overlaps");
  ok(res.localUV.length === res.nodes.length, `localUV aligns 1:1 with nodes (${res.localUV.length})`);
  // tris reference valid, non-degenerate index triples
  const N = res.nodes.length;
  let badTri = 0;
  for (const [a, b, c] of res.tris) if (!(a >= 0 && b >= 0 && c >= 0 && a < N && b < N && c < N) || a === b || b === c || a === c) badTri++;
  ok(res.tris.length > 0 && badTri === 0, `all tris in range + non-degenerate (${badTri} bad of ${res.tris.length})`);
  ok(allFinite(res), "no NaN/Inf in the warm-start assembly");
  // warm-start lift matches foldDoc: a sampled node == applyT(transform, its local coord)
  const fold = F.foldDoc(pieces, seams);
  let liftErr = 0;
  for (const pr of res.pieceRanges) {
    const T = fold.transforms[pr.piece];
    for (const k of [0, Math.floor(pr.count / 2), pr.count - 1]) {
      const gi = pr.start + k, lc = res.localUV[gi], w = applyT(T, [lc[0], lc[1], 0]);
      liftErr = Math.max(liftErr, dist3(w, res.nodes[gi]));
    }
  }
  ok(liftErr < 1e-6, `warm-start nodes == foldDoc placement (max err ${liftErr.toExponential(2)})`);
  ok(res.seamLinks.length > 0, `seam node pairs created (${res.seamLinks.length})`);
}

console.log("=== B+C. Stitch-up closes the seams, no explosion ===");
{
  const { pieces, seams } = tote();
  const stitched = Cl.solveDrape(pieces, seams, { h: H, maxSettle: 0 });   // stitch only, no inflation
  ok(allFinite(stitched), "no NaN/Inf after stitch-up (the make-or-break)");
  const gap = maxSeamGap(stitched);
  ok(gap < 2.0, `all seam pairs close ≤ 2 mm after stitch-up (max ${gap.toFixed(3)} mm)`);
}

console.log("=== D. Inflation: plausible rounded box, girth up vs no-pressure ===");
{
  const { pieces, seams } = tote();
  const flat = Cl.solveDrape(pieces, seams, { h: H, pressure: 0 });        // stitched, NOT inflated
  const puff = Cl.solveDrape(pieces, seams, { h: H });                     // inflated (default pressure)
  ok(allFinite(flat) && allFinite(puff), "no NaN/Inf after full solve (flat + inflated)");
  ok(maxSeamGap(puff) < 2.5, `seams stay closed under inflation (max ${maxSeamGap(puff).toFixed(3)} mm)`);
  // bbox is a plausible inflated box: sorted dims ≈ [120, 250, 300], slightly larger, never blown up
  const dims = bboxDims(puff).sort((a, b) => a - b);
  const nominal = [120, 250, 300];
  let plausible = true;
  for (let i = 0; i < 3; i++) if (!(dims[i] > nominal[i] * 0.8 && dims[i] < nominal[i] * 2)) plausible = false;
  ok(plausible, `inflated bbox ≈ W×H×D, no blow-up (sorted dims ${dims.map((d) => d.toFixed(0))} vs ~${nominal})`);
  // inflation increased the bag's girth (the per-face pressure pushed panels outward)
  const gFlat = girth(flat), gPuff = girth(puff);
  ok(gPuff > gFlat * 1.01, `inflation increased girth (${gPuff.toFixed(0)} > ${gFlat.toFixed(0)})`);
}

console.log("=== E. Determinism ===");
{
  const a = tote(), b = tote();
  const r1 = Cl.solveDrape(a.pieces, a.seams, { h: H });
  const r2 = Cl.solveDrape(b.pieces, b.seams, { h: H });
  ok(r1.nodes.length === r2.nodes.length, "two runs → equal node counts");
  let maxd = 0; for (let i = 0; i < r1.nodes.length; i++) maxd = Math.max(maxd, dist3(r1.nodes[i], r2.nodes[i]));
  ok(maxd < 1e-6, `two runs match (max node delta ${maxd.toExponential(2)})`);
  // geomHash is stable + sensitive
  const h1 = Cl.geomHash(a.pieces, a.seams, { h: H });
  const h2 = Cl.geomHash(b.pieces, b.seams, { h: H });
  ok(h1 === h2, "geomHash stable for identical input");
  const moved = tote(); moved.pieces[1].nodes[2].x += 5;
  ok(Cl.geomHash(moved.pieces, moved.seams, { h: H }) !== h1, "geomHash changes when a node moves");
  ok(Cl.geomHash(a.pieces, a.seams, { h: 15 }) !== h1, "geomHash changes when h changes");
}

console.log("=== F2. Settled-drape cache round-trips ===");
{
  const { pieces, seams } = tote();
  const res = Cl.solveDrape(pieces, seams, { h: H });
  const blob = Cl.encodeDrape(res);
  const back = Cl.decodeDrape(blob);
  ok(back.nodes.length === res.nodes.length && back.tris.length === res.tris.length, "decode restores node + tri counts");
  let maxd = 0; for (let i = 0; i < res.nodes.length; i++) maxd = Math.max(maxd, dist3(res.nodes[i], back.nodes[i]));
  ok(maxd <= 0.09, `decoded nodes match within quantization (max ${maxd.toFixed(4)} mm ≤ 0.087 = 0.05·√3)`);
  let uvd = 0; for (let i = 0; i < res.localUV.length; i++) uvd = Math.max(uvd, Math.abs(res.localUV[i][0] - back.localUV[i][0]), Math.abs(res.localUV[i][1] - back.localUV[i][1]));
  ok(uvd <= 0.06, `decoded localUV match within quantization (max ${uvd.toFixed(4)} mm)`);
  let triOk = true; for (let i = 0; i < res.tris.length; i++) for (let d = 0; d < 3; d++) if (res.tris[i][d] !== back.tris[i][d]) triOk = false;
  ok(triOk, "decoded tri indices identical (lossless)");
  // size sanity: the base64 blob is tens of KB, not hundreds
  const bytes = blob.nodes.length + blob.localUV.length + blob.tris.length;
  ok(bytes < 120000, `cache blob is compact (${(bytes / 1024).toFixed(0)} KB base64 at h=${H})`);
}

console.log("=== F. Degrade / never blank ===");
{
  // an empty doc must not throw (normalizePieces fabricates a default rect, like foldDoc) —
  // it drapes that single seamless sheet flat (no inflation), returning a well-formed result.
  const empty = Cl.solveDrape([], [], { h: H });
  ok(Array.isArray(empty.tris) && allFinite(empty), "empty doc → well-formed finite result (no throw)");
  // a tote plus a stray unsewn square: the square still meshes, the bag still closes/inflates
  const { pieces, seams } = tote();
  pieces.push(rect("p_loose", "Loose", 80, 80));
  const res = Cl.solveDrape(pieces, seams, { h: H });
  ok(allFinite(res) && res.nodes.length > 0, "tote + stray piece still drapes (no NaN, non-empty)");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
