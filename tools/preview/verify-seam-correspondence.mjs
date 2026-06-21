// verify-seam-correspondence.mjs — headless test for seam node pairing (pattern-mesh.seamPairs).
//
// Pure (no three.js): shim global.window, eval the vendored poly2tri + pattern-geom +
// pattern-mesh, mesh two rectangles, and assert the arc-length correspondence the XPBD sewing
// springs will consume — direction (head-to-tail vs head-to-head), endpoint matching, and that
// unequal-length edges still pair every node on the shorter side (the gather case).
//
//   cd ~/sewingapp/tools/preview && node verify-seam-correspondence.mjs
import { readFileSync } from "node:fs";

global.window = {};
const APP = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${APP}/vendor/poly2tri.js`, "utf8"));
eval(readFileSync(`${APP}/pattern-geom.js`, "utf8"));
eval(readFileSync(`${APP}/pattern-mesh.js`, "utf8"));
const M = global.window.PatternMesh;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };
const rectNodes = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
// world position of a boundary node in a mesh
const pos = (mesh, idx) => mesh.nodes[idx];

console.log("=== edgeNodes covers t=0..1 on a rectangle's right edge ===");
{
  const m = M.triangulatePiece({ nodes: rectNodes(200, 300) }, 25);
  const en = M.edgeNodes(m, 1);   // edge 1 = right side (x=200), from (200,0) to (200,300)
  ok(en.length >= 2, `right edge has nodes (${en.length})`);
  ok(Math.abs(en[0].t - 0) < 1e-9 && Math.abs(en[en.length - 1].t - 1) < 1e-9, "edge nodes span t=0..1 inclusive");
  ok(en.every((e) => Math.abs(pos(m, e.node)[0] - 200) < 1e-6), "all right-edge nodes lie on x=200");
  // monotonic in y as t increases
  let mono = true; for (let i = 1; i < en.length; i++) if (pos(m, en[i].node)[1] < pos(m, en[i - 1].node)[1] - 1e-6) mono = false;
  ok(mono, "edge nodes monotonic along the edge");
}

console.log("=== equal-length seam: 1:1 pairing, head-to-tail vs head-to-head ===");
{
  // A right edge (x=200, y 0..300) sewn to B left edge (x=0, y 0..300), both 300 mm
  const A = M.triangulatePiece({ nodes: rectNodes(200, 300) }, 25);
  const B = M.triangulatePiece({ nodes: rectNodes(120, 300) }, 25);
  const eA = 1, eB = 3;   // A right, B left
  const enA = M.edgeNodes(A, eA), enB = M.edgeNodes(B, eB);
  ok(enA.length === enB.length, `equal edges → equal node counts (${enA.length}=${enB.length})`);

  // head-to-tail (default, A0↔B1): A's right edge and B's left edge are wound oppositely
  // (the natural side-by-side sew), so this pairs CORNER-TO-CORNER: A bottom ↔ B bottom.
  const ht = M.seamPairs(A, eA, B, eB, { flip: false });
  ok(ht.length === enA.length, `head-to-tail pairs all nodes (${ht.length})`);
  ok(ht.every(([ia, ib]) => Number.isInteger(ia) && Number.isInteger(ib)), "pairs are valid node indices");
  const [a0, b0] = ht[0];
  ok(Math.abs(pos(A, a0)[1] - 0) < 30 && Math.abs(pos(B, b0)[1] - 0) < 30, "head-to-tail: A bottom ↔ B bottom (corner-to-corner)");
  // pairs run in the same y-direction on both sides (no crossing)
  let preserving = true;
  for (let k = 1; k < ht.length; k++) { if (pos(B, ht[k][1])[1] < pos(B, ht[k - 1][1])[1] - 1e-6) preserving = false; }
  ok(preserving, "head-to-tail: corners line up (B y runs with A y, not crossed)");
  // both top corners also meet
  ok(ht.some(([ia, ib]) => Math.abs(pos(A, ia)[1] - 300) < 30 && Math.abs(pos(B, ib)[1] - 300) < 30), "head-to-tail: A top ↔ B top");

  // head-to-head (flip, A0↔B0): the crossed/twisted sew — A bottom ↔ B top.
  const hh = M.seamPairs(A, eA, B, eB, { flip: true });
  const [a1, b1] = hh[0];
  ok(Math.abs(pos(A, a1)[1] - 0) < 30 && Math.abs(pos(B, b1)[1] - 300) < 30, "head-to-head: A bottom ↔ B top (crossed)");
}

console.log("=== unequal-length seam: every node on the shorter side is used (gather) ===");
{
  // A right edge 300 mm sewn to B left edge 180 mm — the long edge gathers onto the short.
  const A = M.triangulatePiece({ nodes: rectNodes(200, 300) }, 25);
  const B = M.triangulatePiece({ nodes: rectNodes(120, 180) }, 25);
  const eA = 1, eB = 3;
  const enA = M.edgeNodes(A, eA), enB = M.edgeNodes(B, eB);
  ok(enA.length !== enB.length, `unequal edges → different node counts (${enA.length} vs ${enB.length})`);
  const pairs = M.seamPairs(A, eA, B, eB, { flip: false });
  // every node on the longer side appears (N = max count, distinct targets)
  const longSide = enA.length >= enB.length ? 0 : 1;
  const usedLong = new Set(pairs.map((p) => p[longSide]));
  ok(usedLong.size === Math.max(enA.length, enB.length), `all ${Math.max(enA.length, enB.length)} long-side nodes paired (got ${usedLong.size})`);
  // every node on the shorter side is used at least once (nothing left unsewn)
  const shortSide = 1 - longSide;
  const usedShort = new Set(pairs.map((p) => p[shortSide]));
  ok(usedShort.size === Math.min(enA.length, enB.length), `all ${Math.min(enA.length, enB.length)} short-side nodes used (got ${usedShort.size})`);
  // endpoints matched corner-to-corner (head-to-tail): A bottom(0)↔B bottom(0), A top(300)↔B top(180)
  const hasPair = (ay, by) => pairs.some(([ia, ib]) => Math.abs(pos(A, ia)[1] - ay) < 30 && Math.abs(pos(B, ib)[1] - by) < 30);
  ok(hasPair(0, 0) && hasPair(300, 180), "both seam endpoints (corners) are paired");
}

console.log("=== empty/degenerate seam never throws ===");
{
  const A = M.triangulatePiece({ nodes: rectNodes(100, 100) }, 25);
  ok(M.seamPairs(A, 99, A, 0, {}).length === 0, "out-of-range edge → no pairs (no throw)");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
