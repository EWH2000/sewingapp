// verify-mesh.mjs — headless test for panel triangulation (app/static/js/pattern-mesh.js).
//
// Pure (no three.js), so like verify-fold.mjs it needs no module resolver: shim global.window,
// eval the VENDORED poly2tri (the exact build the browser uses — its UMD attaches
// window.poly2tri), then pattern-geom.js (bbox/segment-distance helpers) and pattern-mesh.js,
// and assert the mesh. Mirrors the dual-counter harness of the other verify-*.mjs.
//
//   cd ~/sewingapp/tools/preview && node verify-mesh.mjs
//
// Checks: poly2tri actually loaded (real CDT, not the fallback); boundary resampled to ~h with
// authored-edge tags; interior Steiner nodes present; every triangle inside the polygon; the
// triangle areas tile the polygon area; no duplicate nodes; edge springs ≈ h; finer h → more
// nodes; bending constraints present; a non-convex L stays inside; degenerate input never throws.
import { readFileSync } from "node:fs";

global.window = {};
const APP = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${APP}/vendor/poly2tri.js`, "utf8"));   // → window.poly2tri
eval(readFileSync(`${APP}/pattern-geom.js`, "utf8"));      // → window.PatternGeom
eval(readFileSync(`${APP}/pattern-mesh.js`, "utf8"));      // → window.PatternMesh
const M = global.window.PatternMesh;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };

const rectNodes = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const polyArea = (nodes) => { let s = 0; for (let i = 0, n = nodes.length; i < n; i++) { const a = nodes[i], b = nodes[(i + 1) % n]; s += a.x * b.y - b.x * a.y; } return Math.abs(s) / 2; };
const triArea = (p, q, r) => Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
const inPoly = (x, y, nodes) => M.pointInPoly(x, y, nodes);

ok(!!global.window.poly2tri, "vendored poly2tri loaded (real CDT path exercised)");

console.log("=== Rectangle 200×300, h=25 ===");
{
  const nodes = rectNodes(200, 300), h = 25;
  const m = M.triangulatePiece({ nodes }, h);
  ok(m.nodes.length > 0 && m.tris.length > 0, "mesh non-empty");
  // boundary count = Σ round(edgeLen/h): 200/25=8, 300/25=12, ×2 → 40
  ok(m.boundary.length === 40, `boundary nodes = 40 (got ${m.boundary.length})`);
  ok(m.nodes.length > m.boundary.length, `interior Steiner nodes present (${m.nodes.length} total > ${m.boundary.length} boundary)`);
  // boundaryMeta tags each boundary node with an in-range authored edge + t∈[0,1)
  ok(m.boundaryMeta.length === m.boundary.length, "boundaryMeta aligns with boundary");
  ok(m.boundaryMeta.every((bm) => bm.edge >= 0 && bm.edge < nodes.length && bm.t >= 0 && bm.t < 1), "boundaryMeta edges/t in range");
  // every triangle centroid is inside the polygon
  let outside = 0;
  for (const [a, b, c] of m.tris) {
    const cx = (m.nodes[a][0] + m.nodes[b][0] + m.nodes[c][0]) / 3, cy = (m.nodes[a][1] + m.nodes[b][1] + m.nodes[c][1]) / 3;
    if (!inPoly(cx, cy, nodes)) outside++;
  }
  ok(outside === 0, `all triangles inside the polygon (${outside} outside)`);
  // triangles tile the polygon area
  let area = 0; for (const [a, b, c] of m.tris) area += triArea(m.nodes[a], m.nodes[b], m.nodes[c]);
  ok(Math.abs(area - polyArea(nodes)) / polyArea(nodes) < 0.005, `tri area tiles the polygon (got ${area.toFixed(0)} vs ${polyArea(nodes)})`);
  // no duplicate nodes
  let dup = 0; for (let i = 0; i < m.nodes.length; i++) for (let j = i + 1; j < m.nodes.length; j++) if (Math.hypot(m.nodes[i][0] - m.nodes[j][0], m.nodes[i][1] - m.nodes[j][1]) < 1e-6) dup++;
  ok(dup === 0, `no duplicate nodes (${dup} dup)`);
  // stretch springs ≈ h (no giant edges), bending springs present
  ok(m.dist.length > 0 && m.dist.every((d) => d[2] > 0 && d[2] < 2.2 * h), `dist springs ≈ h (max ${Math.max(...m.dist.map((d) => d[2])).toFixed(1)} < ${2.2 * h})`);
  ok(m.bend.length > 0, `bending constraints present (${m.bend.length})`);
}

console.log("=== Detail scales with h ===");
{
  const nodes = rectNodes(200, 300);
  const coarse = M.triangulatePiece({ nodes }, 40);
  const fine = M.triangulatePiece({ nodes }, 15);
  ok(fine.nodes.length > coarse.nodes.length, `finer h → more nodes (${fine.nodes.length} > ${coarse.nodes.length})`);
}

console.log("=== Non-convex L-shape stays inside ===");
{
  // an L: 200×200 with the top-right 100×100 removed
  const nodes = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 200 }, { x: 0, y: 200 }];
  const m = M.triangulatePiece({ nodes }, 20);
  let outside = 0;
  for (const [a, b, c] of m.tris) {
    const cx = (m.nodes[a][0] + m.nodes[b][0] + m.nodes[c][0]) / 3, cy = (m.nodes[a][1] + m.nodes[b][1] + m.nodes[c][1]) / 3;
    if (!inPoly(cx, cy, nodes)) outside++;
  }
  ok(m.tris.length > 0 && outside === 0, `L-shape: all triangles inside the notch-free region (${outside} outside)`);
  let area = 0; for (const [a, b, c] of m.tris) area += triArea(m.nodes[a], m.nodes[b], m.nodes[c]);
  ok(Math.abs(area - polyArea(nodes)) / polyArea(nodes) < 0.01, `L-shape tiled (got ${area.toFixed(0)} vs ${polyArea(nodes)})`);
}

console.log("=== Degenerate input never throws ===");
{
  const m = M.triangulatePiece({ nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }, 20);   // <3 nodes
  ok(m.nodes.length === 0 && m.tris.length === 0, "two-node piece → empty mesh (no throw)");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
