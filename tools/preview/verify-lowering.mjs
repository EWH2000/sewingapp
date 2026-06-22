// verify-lowering.mjs — headless test for G.loweredBoundary (the dart-lowering contract that
// BOTH the print path (pieceGeom/pieceExtras) AND the M5c drape (triangulatePiece) consume, so
// their boundary-edge indexing agrees. Pure (no three.js, no Maker), like verify-mesh.mjs.
//
//   cd ~/sewingapp/tools/preview && node verify-lowering.mjs
//
// Checks: a plain piece lowers to itself (identity); a wedge dart splices 3 boundary nodes + names
// the two leg edges; legs are isoceles (clean drape pairing); the apex sits `depth` into the
// interior; a curve edit does NOT change the lowered node count (curves aren't expanded here);
// determinism; authored node coords are never mutated.
import { readFileSync } from "node:fs";

global.window = {};
const APP = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${APP}/pattern-geom.js`, "utf8"));   // → window.PatternGeom (no maker needed)
const G = global.window.PatternGeom;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const norm = (p) => G.normalizePieces({ pieces: [p] })[0];
const rectNodes = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

console.log("=== plain piece lowers to itself (identity) ===");
{
  const p = norm({ name: "Plain", nodes: rectNodes(200, 300) });
  const lb = G.loweredBoundary(p);
  ok(lb.nodes.length === 4, `4 authored nodes → 4 lowered nodes (${lb.nodes.length})`);
  ok(lb.edgeMap.join(",") === "0,1,2,3", `edgeMap is identity (${lb.edgeMap.join(",")})`);
  ok(lb.dartLegs.length === 0 && lb.dartFolds.length === 0 && !lb.hasDarts, "no darts → empty legs/folds");
  // coords identical to authored
  ok(lb.nodes.every((n, i) => n.x === p.nodes[i].x && n.y === p.nodes[i].y), "lowered coords match authored");
}

console.log("=== wedge dart splices 3 nodes + names the leg edges ===");
{
  const p = norm({ name: "Front", nodes: rectNodes(200, 300),
    darts: [{ id: "d1", edge: 0, center: 0.5, width: 30, depth: 90, kind: "wedge" }] });
  const before = JSON.stringify(p.nodes);
  const lb = G.loweredBoundary(p);
  ok(lb.nodes.length === 7, `4 + 3 dart nodes = 7 lowered nodes (${lb.nodes.length})`);
  ok(JSON.stringify(p.nodes) === before, "piece.nodes NOT mutated (edge identity preserved)");
  ok(lb.dartLegs.length === 1, "one dart → one leg pair");
  const { legA, legB } = lb.dartLegs[0];
  // leg edges are consecutive around the boundary (sA→apex, apex→sB), so legB === legA + 1
  ok(legB === legA + 1, `dart legs are consecutive boundary edges (${legA},${legB})`);
  ok(lb.edgeMap[legA] === -1 && lb.edgeMap[legB] === -1, "dart-leg edges map to authored edge -1");
  // legs isoceles: |sA→apex| == |apex→sB|
  const n = lb.nodes;
  const lenA = dist(n[legA], n[legA + 1]), lenB = dist(n[legB], n[(legB + 1) % n.length]);
  ok(approx(lenA, lenB, 0.05), `dart legs equal length (${lenA.toFixed(2)} ≈ ${lenB.toFixed(2)})`);
  // apex is the shared middle node; it sits `depth` (90) above the bottom edge (y=0)
  const apex = n[legA + 1];
  ok(approx(apex.y, 90, 0.5) && approx(apex.x, 100, 0.5), `apex at (100,90) = depth into interior (${apex.x},${apex.y})`);
  // dart mouth width: the two split points straddle center by width
  const sA = n[legA], sB = n[(legB + 1) % n.length];
  ok(approx(dist(sA, sB), 30, 0.5), `dart mouth width = 30 (${dist(sA, sB).toFixed(1)})`);
}

console.log("=== a curve edit does NOT change the lowered node count ===");
{
  const straight = norm({ name: "C", nodes: rectNodes(200, 300) });
  const curved = norm({ name: "C", nodes: rectNodes(200, 300), edges: { "2": { curve: { type: "quad", cp: [0.5, 0.2] } } } });
  ok(G.loweredBoundary(straight).nodes.length === G.loweredBoundary(curved).nodes.length,
     "curves are flattened in pieceGeom, not expanded in loweredBoundary (node count unchanged)");
}

console.log("=== slash dart draws a fold line, leaves the boundary intact ===");
{
  const p = norm({ name: "S", nodes: rectNodes(200, 300),
    darts: [{ id: "d2", edge: 0, center: 0.5, width: 20, depth: 60, kind: "slash" }] });
  const lb = G.loweredBoundary(p);
  ok(lb.nodes.length === 4, "slash dart does NOT splice boundary nodes (interior fold only)");
  ok(lb.dartFolds.length === 1, "slash dart emits one fold line");
}

console.log("=== determinism ===");
{
  const p = norm({ name: "D", nodes: rectNodes(200, 300),
    darts: [{ id: "d1", edge: 0, center: 0.4, width: 24, depth: 80, kind: "wedge" }] });
  ok(JSON.stringify(G.loweredBoundary(p)) === JSON.stringify(G.loweredBoundary(p)), "loweredBoundary is deterministic");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
