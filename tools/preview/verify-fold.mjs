// verify-fold.mjs — headless test for the rigid fold-up solver (app/static/js/pattern-fold.js).
//
// The solver is pure (no three.js, no DOM), so — unlike verify-box-mesh.mjs — this needs no
// module resolver: just shim global.window, eval pattern-geom.js (for normalize/edge helpers)
// then pattern-fold.js, and assert. Mirrors verify-editor-geom.mjs's dual-counter harness.
//
//   cd ~/sewingapp/tools/preview && node verify-fold.mjs
//
// Fixtures: a square open box (4 free tree angles → solver recovers 90°, closes), a 4-panel
// tube (deep ancestor chain), the worked boxy tote (fixed 90° tree, closes), a mismatched
// panel (degrades to tree), and structural cases (coplanar, disconnected, forced root). The
// rigidity catch-all (folded edge length == authored edge length) guards the quaternion path.
//
// NB: PREVIEW.md §3.6(a)'s worked-tote JSON pairs front's 250 mm vertical edge to a side's
// 120 mm TOP edge (a non-hingeable slip); the geometrically-consistent vertical pairings are
// derived below and used here.
import { readFileSync } from "node:fs";

global.window = {};
const ROOT = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${ROOT}/pattern-geom.js`, "utf8"));   // → window.PatternGeom
eval(readFileSync(`${ROOT}/pattern-fold.js`, "utf8"));   // → window.PatternFold
const G = global.window.PatternGeom;
const F = global.window.PatternFold;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };

// ── minimal vec/quat to place local nodes by the solver's transforms ──────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
function qrot(q, v) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const placeNode = (T, n) => add(T.pos, qrot(T.quat, [n.x, n.y, 0]));
const worldEdgeLen = (T, nodes, i) => len(sub(placeNode(T, nodes[(i + 1) % nodes.length]), placeNode(T, nodes[i])));
const localEdgeLen = (nodes, i) => { const a = nodes[i], b = nodes[(i + 1) % nodes.length]; return Math.hypot(b.x - a.x, b.y - a.y); };

const rect = (id, name, w, h) => ({ id, name, count: 1, seamMm: 0, cornerRadius: 0, closed: true,
  nodes: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] });

// rigidity catch-all: every folded edge length must equal its authored length.
function assertRigid(label, pieces, res) {
  let bad = 0;
  for (const p of pieces) {
    const T = res.transforms[p.id]; if (!T) continue;
    for (let i = 0; i < p.nodes.length; i++)
      if (Math.abs(worldEdgeLen(T, p.nodes, i) - localEdgeLen(p.nodes, i)) > 1e-6) bad++;
  }
  ok(bad === 0, `${label}: all folded edges rigid (${bad} bad)`);
}
const maxGap = (res) => res.closures.reduce((m, c) => (c.gapMm != null && c.gapMm > m ? c.gapMm : m), 0);
const angleOf = (res, seamId) => { const h = res.hinges.find((x) => x.seam === seamId); return h ? h.angleDeg : null; };

// ───────────────────────────────────────────────────────────────────────────────
console.log("=== Fixture A: square open box (4 free tree angles → recover 90°, close) ===");
{
  const s = 100;
  const pieces = [rect("base", "Base", s, s), rect("front", "Front", s, s), rect("back", "Back", s, s),
    rect("sideL", "Side L", s, s), rect("sideR", "Side R", s, s)];
  const seams = [
    { id: "t_bf", a: { piece: "base", edge: 0 }, b: { piece: "front", edge: 0 }, foldAngle: null },
    { id: "t_bb", a: { piece: "base", edge: 2 }, b: { piece: "back", edge: 0 }, foldAngle: null },
    { id: "t_bl", a: { piece: "base", edge: 3 }, b: { piece: "sideL", edge: 0 }, foldAngle: null },
    { id: "t_br", a: { piece: "base", edge: 1 }, b: { piece: "sideR", edge: 0 }, foldAngle: null },
    { id: "c_fl", a: { piece: "front", edge: 3 }, b: { piece: "sideL", edge: 3 }, foldAngle: null },
    { id: "c_fr", a: { piece: "front", edge: 1 }, b: { piece: "sideR", edge: 1 }, foldAngle: null },
    { id: "c_bl", a: { piece: "back", edge: 3 }, b: { piece: "sideL", edge: 1 }, foldAngle: null },
    { id: "c_br", a: { piece: "back", edge: 1 }, b: { piece: "sideR", edge: 3 }, foldAngle: null },
  ];
  const res = F.foldDoc(pieces, seams);
  ok(res.root === "base", `root = base (degree 4), got ${res.root}`);
  ok(res.cycles === 4, `cycles = 4, got ${res.cycles}`);
  ok(res.mode === "closed", `mode = closed, got ${res.mode}`);
  ok(maxGap(res) < 1, `max closure gap < 1 mm, got ${maxGap(res).toFixed(3)}`);
  const angles = ["t_bf", "t_bb", "t_bl", "t_br"].map((id) => angleOf(res, id));
  ok(angles.every((a) => Math.abs(Math.abs(a) - 90) < 0.5), `recovered tree angles ≈ 90°, got [${angles.map((a) => a.toFixed(1))}]`);
  ok(Object.keys(res.transforms).length === 5, "all 5 pieces placed");
  assertRigid("A", pieces, res);
}

console.log("=== Fixture B: 4-panel tube (deep ancestor chain) ===");
{
  const s = 100;
  const pieces = [rect("p0", "P0", s, s), rect("p1", "P1", s, s), rect("p2", "P2", s, s), rect("p3", "P3", s, s)];
  const seams = [
    { id: "t01", a: { piece: "p0", edge: 1 }, b: { piece: "p1", edge: 3 }, foldAngle: null },
    { id: "t12", a: { piece: "p1", edge: 1 }, b: { piece: "p2", edge: 3 }, foldAngle: null },
    { id: "t23", a: { piece: "p2", edge: 1 }, b: { piece: "p3", edge: 3 }, foldAngle: null },
    { id: "c30", a: { piece: "p3", edge: 1 }, b: { piece: "p0", edge: 3 }, foldAngle: null },
  ];
  const res = F.foldDoc(pieces, seams);
  ok(res.cycles === 1, `cycles = 1, got ${res.cycles}`);
  ok(res.mode === "closed", `mode = closed, got ${res.mode}`);
  ok(maxGap(res) < 1, `tube closes, gap < 1 mm, got ${maxGap(res).toFixed(3)}`);
  ok(res.hinges.every((h) => Math.abs(Math.abs(h.angleDeg) - 90) < 0.5),
    `deep-chain tree angles ≈ 90°, got [${res.hinges.map((h) => h.angleDeg.toFixed(1))}]`);
  assertRigid("B", pieces, res);
}

console.log("=== Fixture C: worked boxy tote (fixed 90° tree, closes) ===");
function tote(sideRwidth) {
  const pieces = [
    rect("p_base", "Base", 300, 120), rect("p_front", "Front", 300, 250), rect("p_back", "Back", 300, 250),
    rect("p_sideL", "Side L", 120, 250), rect("p_sideR", "Side R", sideRwidth || 120, 250),
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
{
  const { pieces, seams } = tote();
  const res = F.foldDoc(pieces, seams);
  ok(res.root === "p_base", `root = base (degree 4 > walls' 3), got ${res.root}`);
  ok(res.cycles === 4, `cycles = 4, got ${res.cycles}`);
  ok(res.mode === "closed", `mode = closed, got ${res.mode}`);
  ok(maxGap(res) < 1, `tote closes, gap < 1 mm, got ${maxGap(res).toFixed(3)}`);
  // base flat on the floor (lowest y ≈ 0), walls rise above
  const baseT = res.transforms.p_base;
  const baseYs = pieces[0].nodes.map((n) => placeNode(baseT, n)[1]);
  ok(baseYs.every((y) => Math.abs(y) < 1e-3), "base lies on the floor (y ≈ 0)");
  const frontT = res.transforms.p_front;
  const topY = Math.max(...pieces[1].nodes.map((n) => placeNode(frontT, n)[1]));
  ok(topY > 200, `front wall rises (top y ≈ ${topY.toFixed(0)})`);
  assertRigid("C", pieces, res);
}

console.log("=== Fixture D: mismatched panel degrades to tree ===");
{
  const { pieces, seams } = tote(130);   // sideR 130 wide vs base edge 120 → non-hingeable
  const res = F.foldDoc(pieces, seams);
  ok(res.nonHingeable >= 1, `flags ≥1 non-hingeable seam, got ${res.nonHingeable}`);
  ok(res.mode === "tree", `mode = tree, got ${res.mode}`);
  ok(Object.keys(res.transforms).length === 5, "all 5 pieces still placed (never blanks)");
  assertRigid("D", pieces, res);
}

console.log("=== Fixture E: structural (coplanar, disconnected, forced root) ===");
{
  // E1 — two pieces, one seam, foldAngle 0 → coplanar, no cycles
  const pieces = [rect("a", "A", 100, 80), rect("b", "B", 100, 80)];
  const seams = [{ id: "s", a: { piece: "a", edge: 1 }, b: { piece: "b", edge: 3 }, foldAngle: 0 }];
  const res = F.foldDoc(pieces, seams);
  ok(res.cycles === 0, `E1 cycles = 0, got ${res.cycles}`);
  ok(res.mode === "closed", `E1 mode = closed (tree always closes), got ${res.mode}`);
  // the sewn edges coincide (a.edge1 endpoints == b.edge3 endpoints, head-to-tail)
  const Ta = res.transforms.a, Tb = res.transforms.b;
  const a0 = placeNode(Ta, pieces[0].nodes[1]), a1 = placeNode(Ta, pieces[0].nodes[2]);
  const b0 = placeNode(Tb, pieces[1].nodes[3]), b1 = placeNode(Tb, pieces[1].nodes[0]);
  const seamGap = Math.min(Math.max(len(sub(a0, b1)), len(sub(a1, b0))), Math.max(len(sub(a0, b0)), len(sub(a1, b1))));
  ok(seamGap < 1e-6, `E1 sewn edge coincides (gap ${seamGap.toFixed(4)})`);
  assertRigid("E1", pieces, res);

  // E2 — a third piece with no seam is still placed, doesn't add a cycle
  const pieces2 = pieces.concat([rect("c", "C", 60, 60)]);
  const res2 = F.foldDoc(pieces2, seams);
  ok(res2.cycles === 0 && res2.transforms.c, "E2 disconnected piece placed, no extra cycle");

  // E3 — forced root override
  const res3 = F.foldDoc(pieces, seams, { root: "b" });
  ok(res3.root === "b", `E3 forced root honored, got ${res3.root}`);
}

console.log("=== Fixture F: no seams → flat layout (mode tree, never blank) ===");
{
  const pieces = [rect("x", "X", 100, 100), rect("y", "Y", 80, 80)];
  const res = F.foldDoc(pieces, []);
  ok(res.mode === "tree", `no-seams mode = tree, got ${res.mode}`);
  ok(res.cycles === 0 && Object.keys(res.transforms).length === 2, "both pieces laid out flat");
  assertRigid("F", pieces, res);
}

console.log("=== Fixture G: authored direction (anchors) honored on a closure seam ===");
{
  const s = 100;
  const pieces = [rect("base", "Base", s, s), rect("front", "Front", s, s), rect("back", "Back", s, s),
    rect("sideL", "Side L", s, s), rect("sideR", "Side R", s, s)];
  const base = (anchors) => [
    { id: "t_bf", a: { piece: "base", edge: 0 }, b: { piece: "front", edge: 0 }, foldAngle: null },
    { id: "t_bb", a: { piece: "base", edge: 2 }, b: { piece: "back", edge: 0 }, foldAngle: null },
    { id: "t_bl", a: { piece: "base", edge: 3 }, b: { piece: "sideL", edge: 0 }, foldAngle: null },
    { id: "t_br", a: { piece: "base", edge: 1 }, b: { piece: "sideR", edge: 0 }, foldAngle: null },
    { id: "c_fl", a: { piece: "front", edge: 3 }, b: { piece: "sideL", edge: 3 }, foldAngle: null, anchors },
    { id: "c_fr", a: { piece: "front", edge: 1 }, b: { piece: "sideR", edge: 1 }, foldAngle: null },
    { id: "c_bl", a: { piece: "back", edge: 3 }, b: { piece: "sideL", edge: 1 }, foldAngle: null },
    { id: "c_br", a: { piece: "back", edge: 1 }, b: { piece: "sideR", edge: 3 }, foldAngle: null },
  ];
  const gapFL = (res) => { const c = res.closures.find((x) => x.seam === "c_fl"); return c ? c.gapMm : Infinity; };
  const g1 = gapFL(F.foldDoc(pieces, base([{ ta: 0, tb: 0 }, { ta: 1, tb: 1 }])));   // forced head-to-head
  const g2 = gapFL(F.foldDoc(pieces, base([{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }])));   // forced head-to-tail
  // one forced direction closes c_fl (gap≈0), the other is wrong (large gap) → anchors honored
  ok(Math.min(g1, g2) < 1 && Math.max(g1, g2) > 10, `forced closure direction honored (gaps ${g1.toFixed(1)}, ${g2.toFixed(1)})`);
}

console.log("=== Fixture H: tote with a strap (excluded from the fold, rendered as handles) ===");
{
  const { pieces, seams } = tote();
  const strap = rect("p_strap", "Strap", 600, 25); strap.count = 2;   // long thin band, cut ×2
  pieces.push(strap);
  // both strap short ends (edges 1 & 3, length 25) sew to the front TOP edge (front edge 2)
  seams.push(
    { id: "s_strap_l", a: { piece: "p_strap", edge: 1 }, b: { piece: "p_front", edge: 2 }, foldAngle: null },
    { id: "s_strap_r", a: { piece: "p_strap", edge: 3 }, b: { piece: "p_front", edge: 2 }, foldAngle: null },
  );
  const res = F.foldDoc(pieces, seams);
  ok(res.mode === "closed", `bag still closes with strap excluded, got ${res.mode}`);
  ok(res.cycles === 4, `cycles unchanged = 4, got ${res.cycles}`);
  ok(res.nonHingeable === 0, `strap seams not counted non-hingeable, got ${res.nonHingeable}`);
  ok(res.root === "p_base", `root unchanged = p_base, got ${res.root}`);
  ok(Object.keys(res.transforms).length === 5, `5 BAG pieces placed (strap excluded), got ${Object.keys(res.transforms).length}`);
  ok(!res.transforms.p_strap, "strap absent from rigid transforms");
  ok(Array.isArray(res.straps) && res.straps.length === 2, `2 handle instances (grab + mirror), got ${res.straps && res.straps.length}`);
  const st = res.straps[0], mir = res.straps[1];
  ok(st && st.anchors.length === 2, `handle has 2 anchors, got ${st && st.anchors.length}`);
  ok(st && st.lenMm > 0 && st.widthMm > 0, `strap dims reported (${st && st.lenMm}×${st && st.widthMm})`);
  const A = st.anchors[0], B = st.anchors[1];
  ok(len(sub(A, B)) > 1, `anchors spread, not degenerate (got ${len(sub(A, B)).toFixed(2)})`);
  ok(A[1] > 200 && B[1] > 200, `anchors near the bag top (front height 250), got y=${A[1].toFixed(0)},${B[1].toFixed(0)}`);
  ok(mir && mir.mirrored === true, "second instance flagged mirrored");
  ok(mir && (len(sub(mir.anchors[0], A)) > 30 || len(sub(mir.anchors[1], B)) > 30), "mirror handle is offset from the original (opposite face)");
}

console.log("=== Fixture J: strap SPANS the two sides (width runs along the side edges) ===");
{
  const { pieces, seams } = tote();
  const strap = rect("p_strap", "Strap", 600, 25); strap.count = 2;
  pieces.push(strap);
  // strap short ends sewn to the LEFT and RIGHT side top edges (side edge 2) — an over-the-top span
  seams.push(
    { id: "s_strap_l", a: { piece: "p_strap", edge: 3 }, b: { piece: "p_sideL", edge: 2 }, foldAngle: null },
    { id: "s_strap_r", a: { piece: "p_strap", edge: 1 }, b: { piece: "p_sideR", edge: 2 }, foldAngle: null },
  );
  const res = F.foldDoc(pieces, seams);
  ok(res.mode === "closed", `bag still closes, got ${res.mode}`);
  ok(res.straps.length === 1, `span → one handle (no mirror), got ${res.straps.length}`);
  const st = res.straps[0];
  ok(st.grab === false, "span handle (not a grab handle)");
  ok(Array.isArray(st.widthDir), "widthDir reported");
  const wd = st.widthDir, A = st.anchors[0], B = st.anchors[1];
  ok(Math.abs(wd[1]) < 0.2, `widthDir is horizontal (|y|≈0), got y=${wd[1].toFixed(2)}`);
  // chord (span direction) should be ~perpendicular to the width (the strap meets the side edges square)
  const chord = sub(B, A), cl = len(chord) || 1; const cdir = [chord[0]/cl, chord[1]/cl, chord[2]/cl];
  const dotcw = Math.abs(cdir[0]*wd[0] + cdir[1]*wd[1] + cdir[2]*wd[2]);
  ok(dotcw < 0.3, `width ⊥ span direction (|cos|≈0), got ${dotcw.toFixed(2)}`);
  ok(A[1] > 200 && B[1] > 200, `anchors near the bag top, got y=${A[1].toFixed(0)},${B[1].toFixed(0)}`);
}

console.log("=== Fixture I: isStrapPiece predicate (role / name / shape) ===");
{
  const strap = rect("p_strap", "Strap", 600, 25);
  const strapSeams = [
    { id: "s1", a: { piece: "p_strap", edge: 1 }, b: { piece: "p_front", edge: 2 } },
    { id: "s2", a: { piece: "p_strap", edge: 3 }, b: { piece: "p_front", edge: 2 } },
  ];
  ok(F.isStrapPiece(strap, strapSeams) === true, "long-thin band sewn at short ends → strap");
  const front = rect("p_front", "Front", 300, 250);
  ok(F.isStrapPiece(front, []) === false, "square-ish panel → not a strap");
  ok(F.isStrapPiece({ ...front, role: "strap" }, []) === true, "role:strap forces strap");
  ok(F.isStrapPiece({ ...strap, role: "panel" }, strapSeams) === false, "role:panel forces panel");
  ok(F.isStrapPiece(rect("p_h", "Shoulder Handle", 200, 250), []) === true, "name match (handle) → strap");
  const longPanel = rect("p_lp", "Gusset", 600, 60);   // long & thin but sewn on its LONG side
  const longSeam = [{ id: "g1", a: { piece: "p_lp", edge: 0 }, b: { piece: "p_x", edge: 0 } }];   // edge 0 = 600 mm side
  ok(F.isStrapPiece(longPanel, longSeam) === false, "long thin panel sewn on a LONG edge → not a strap");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
