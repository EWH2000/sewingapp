// verify-sleeve.mjs — headless tests for the set-in SLEEVE drafter in pattern-geom.js
// (edgeArcLenMm / armholeLengthMm / measureCapMm / sleevePiece / draftSleeve). Same window-shim
// bootstrap as verify-editor-geom.mjs (eval the browser modules in Node with npm makerjs + pdf-lib).
//   cd ~/sewingapp/tools/tiling && node verify-sleeve.mjs
//
// Checks: arc-length of a curved edge; the cap-length bisection converges to the armhole × (1+ease)
// and never mutates the spec's nodes; cap height is monotone (so the bisection is valid); the FRONT
// cap is flatter than the BACK; the ok flag drops when the armhole can't be reached; a drafted sleeve
// lowers to a 0-bad-page 1:1 Letter PDF (the print-spine sentinel); and the cut↔seam-line ease delta
// (Risk #4) is measured + asserted to land inside the ease allowance, so it is never silent.
import * as PDFLib from "pdf-lib";
import makerjs from "makerjs";
import { readFileSync } from "node:fs";

global.window = { PDFLib, makerjs };
const ROOT = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${ROOT}/pattern-pdf.js`, "utf8"));
eval(readFileSync(`${ROOT}/pattern-geom.js`, "utf8"));
const G = global.window.PatternGeom;
const P = global.window.PatternPDF;
const { PDFDocument } = PDFLib;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };
const norm = (p) => G.normalizePieces({ pieces: [p] })[0];

// the seeded sleeveless tank bodice's armhole edges (front e2 + back e2) — the real target.
const bodice = (neckDip, dart) => norm({
  id: "b", name: "Bodice", count: 1, seamMm: 12, closed: true,
  nodes: [{ x: 50, y: 0 }, { x: 440, y: 0 }, { x: 490, y: 230 }, { x: 452, y: 420 },
          { x: 311, y: 400 }, { x: 179, y: 400 }, { x: 38, y: 420 }, { x: 0, y: 230 }],
  edges: { "2": { curve: { type: "quad", cp: [0.5, 0.16] } }, "4": { curve: { type: "quad", cp: [0.5, neckDip] } }, "6": { curve: { type: "quad", cp: [0.5, 0.16] } } },
  darts: dart ? [{ id: "d", edge: 0, center: 0.5, width: 26, depth: 120, kind: "wedge" }] : [],
});
const bf = bodice(0.28, true), bb = bodice(0.10, false);
const aF = G.edgeArcLenMm(bf, 2), aB = G.edgeArcLenMm(bb, 2);

console.log("=== edgeArcLenMm ===");
{
  const sq = norm(G.rectPiece("R", 200, 100));
  ok(Math.abs(G.edgeArcLenMm(sq, 0) - 200) < 1e-6, "straight edge arc = chord length");
  const chord = Math.hypot(bf.nodes[3].x - bf.nodes[2].x, bf.nodes[3].y - bf.nodes[2].y);
  ok(aF > chord, `curved armhole arc (${aF.toFixed(1)}) > its chord (${chord.toFixed(1)})`);
  ok(Math.abs(aF - aB) < 0.01, "symmetric front/back armhole measure equal");
  ok(Math.abs(G.armholeLengthMm(bf, 2, bb, 2) - (aF + aB)) < 1e-6, "armholeLengthMm = front + back");
  console.log(`  armhole front+back = ${(aF + aB).toFixed(1)} mm`);
}

console.log("=== measureCapMm is monotone in cap height (bisection is valid) ===");
{
  let prev = -1, mono = true;
  for (let ch = 40; ch <= 240; ch += 20) {
    const L = G.measureCapMm(G.sleevePiece({ bicepMm: 320, underLenMm: 130, capHeightMm: ch }));
    if (L <= prev) mono = false;
    prev = L;
  }
  ok(mono, "cap seamline length strictly increases with cap height");
}

console.log("=== draftSleeve converges + shapes ===");
{
  for (const ease of [0, 0.06, 0.12]) {
    const r = G.draftSleeve({ armholeFrontMm: aF, armholeBackMm: aB, capEaseFrac: ease });
    ok(Math.abs(r.capLenMm - r.targetMm) < 0.5, `ease ${ease}: cap matches armhole×(1+ease) within 0.5mm (cap ${r.capLenMm}, target ${r.targetMm})`);
    ok(r.ok, `ease ${ease}: ok=true (reachable)`);
    ok(r.capHeightMm > 90 && r.capHeightMm < 200, `ease ${ease}: realistic cap height (${r.capHeightMm}mm)`);
  }
  // front cap (e3) flatter than back cap (e2)
  const p = G.sleevePiece({ bicepMm: 320, underLenMm: 200, capHeightMm: 140 });
  ok(G.edgeArcLenMm(p, 3) < G.edgeArcLenMm(p, 2), `front cap (${G.edgeArcLenMm(p, 3).toFixed(1)}) flatter than back (${G.edgeArcLenMm(p, 2).toFixed(1)})`);
  // the cap bulges OUT (cap arc > chord) — it's a dome, not a degenerate line
  const a = p.nodes[2], b = p.nodes[3], chord = Math.hypot(b.x - a.x, b.y - a.y);
  ok(G.edgeArcLenMm(p, 2) > chord, `back cap bulges outward (arc ${G.edgeArcLenMm(p, 2).toFixed(1)} > chord ${chord.toFixed(1)})`);
  // 5 nodes, place3d.role sleeve, 2 balance notches (single front, double back)
  const np = norm(p);
  ok(np.nodes.length === 5, "sleeve has 5 nodes");
  ok(np.place3d && np.place3d.role === "sleeve", "place3d.role = 'sleeve'");
  ok(np.notches.length === 2 && np.notches.find((n) => n.edge === 3 && n.type === "single") && np.notches.find((n) => n.edge === 2 && n.type === "double"),
     "single notch on front cap (e3), double on back cap (e2)");
  ok(np.edges && np.edges["2"].curve.type === "cubic" && np.edges["3"].curve.type === "cubic", "both cap edges are cubic");
}

console.log("=== drafter output is RENDER-READY (editor pushes it raw, BEFORE normalize) ===");
{
  // editor.addSleeve pushes the drafted piece straight into state.pieces and renders before the next
  // normalize — so drawPaths reads piece.placements / piece.notches DIRECTLY. A missing field blanked
  // the whole canvas (the "+ Sleeve crashes the editor" bug). Assert the raw piece has what render needs.
  for (const piece of [G.sleevePiece({ bicepMm: 300, underLenMm: 150, capHeightMm: 130 }),
                       G.draftSleeve({ armholeFrontMm: aF, armholeBackMm: aB }).piece]) {
    ok(Array.isArray(piece.placements), "raw sleeve has a placements array (drawPaths reads it directly)");
    ok(Array.isArray(piece.notches), "raw sleeve has a notches array");
    ok(Array.isArray(piece.nodes) && piece.nodes.length === 5, "raw sleeve has its 5 nodes");
    ok("layout" in piece, "raw sleeve has a layout slot");
    let threw = false;
    try { (piece.placements).forEach(() => {}); for (const n of piece.notches) void n; } catch (_) { threw = true; }
    ok(!threw, "render's direct reads (placements.forEach / for..of notches) don't throw on the raw piece");
  }
}

console.log("=== ok flag drops when the armhole is unreachable (cap too small for a huge armhole) ===");
{
  // a tiny bicep with a giant armhole: even a max-height cap can't reach the target.
  const r = G.draftSleeve({ armholeFrontMm: 2000, armholeBackMm: 2000, bicepMm: 120, capEaseFrac: 0.06 });
  ok(!r.ok, "ok=false (soft warning) when cap can't reach a too-large armhole");
  ok(r.piece && r.piece.nodes.length === 5, "still returns a printable piece (never a hard fail)");
}

console.log("=== spec nodes are never mutated (sleevePiece is a fresh builder) ===");
{
  const spec = { bicepMm: 300, underLenMm: 150, capHeightMm: 130 };
  const before = JSON.stringify(spec);
  G.sleevePiece(spec); G.sleevePiece(spec);
  ok(JSON.stringify(spec) === before, "sleevePiece does not mutate its spec");
}

console.log("=== Risk #4: cut↔seam-line ease delta is measured + within the ease allowance ===");
{
  const sa = 12, ease = 0.06;
  // inward-offset arc of edge i (flatten the curve, push each sample toward the piece centroid by sa).
  const insetEdgeArc = (piece, i) => {
    const n = piece.nodes.length, a = piece.nodes[i], b = piece.nodes[(i + 1) % n];
    let cx = 0, cy = 0; for (const q of piece.nodes) { cx += q.x; cy += q.y; } cx /= n; cy /= n;
    const e = piece.edges && piece.edges[String(i)], c = e && e.curve;
    const pts = [];
    const S = 64;
    for (let s = 0; s <= S; s++) {
      const t = s / S;
      let p;
      if (!c) { p = [a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)]; }
      else {
        const cp = c.type === "cubic"
          ? [[a.x, a.y], G.edgeLocalToWorld(a, b, c.cp[0], c.cp[1]), G.edgeLocalToWorld(a, b, c.cp[2], c.cp[3]), [b.x, b.y]]
          : [[a.x, a.y], G.edgeLocalToWorld(a, b, c.cp[0], c.cp[1]), [b.x, b.y]];
        // de Casteljau
        let q = cp.map((z) => z.slice());
        while (q.length > 1) { const nx = []; for (let k = 0; k + 1 < q.length; k++) nx.push([q[k][0] + (q[k + 1][0] - q[k][0]) * t, q[k][1] + (q[k + 1][1] - q[k][1]) * t]); q = nx; }
        p = q[0];
      }
      // push toward centroid by sa
      let dx = cx - p[0], dy = cy - p[1], L = Math.hypot(dx, dy) || 1;
      pts.push([p[0] + (dx / L) * sa, p[1] + (dy / L) * sa]);
    }
    let len = 0; for (let s = 1; s < pts.length; s++) len += Math.hypot(pts[s][0] - pts[s - 1][0], pts[s][1] - pts[s - 1][1]);
    return len;
  };
  const r = G.draftSleeve({ armholeFrontMm: aF, armholeBackMm: aB, capEaseFrac: ease, seamMm: sa });
  const slv = r.piece;
  const capCut = G.measureCapMm(slv), capSeam = insetEdgeArc(slv, 2) + insetEdgeArc(slv, 3);
  const armCut = aF + aB, armSeam = insetEdgeArc(bf, 2) + insetEdgeArc(bb, 2);
  // the bisection matched the CUT lines; the physical ease lives on the SEAM lines.
  const seamEase = capSeam - armSeam, allowance = ease * armCut;
  console.log(`  cut: cap ${capCut.toFixed(1)} vs armhole ${armCut.toFixed(1)} (matched)`);
  console.log(`  seam: cap ${capSeam.toFixed(1)} vs armhole ${armSeam.toFixed(1)} → seam-line ease ${seamEase.toFixed(1)}mm (allowance ${allowance.toFixed(1)}mm)`);
  ok(Math.abs(seamEase) <= allowance + 6, `seam-line ease (${seamEase.toFixed(1)}mm) lands within the ease allowance (±${(allowance + 6).toFixed(1)}mm) — cut/seam discrepancy absorbed`);
}

console.log("=== auto-detect armholes + cross-pairing (simulates editor.addSleeve on the seeded bodice) ===");
{
  const { bodice } = await import("/home/ehill/sewingapp/tools/seed-examples.mjs");
  const seed = bodice();                              // real seeded tank: crossed shoulders + curved armholes
  const front = G.normalizePieces({ pieces: [seed.pieces[0]] })[0];
  const back = G.normalizePieces({ pieces: [seed.pieces[1]] })[0];
  const fArm = G.bodiceArmholes(front), bArm = G.bodiceArmholes(back);
  ok(fArm && fArm.R.edge === 2 && fArm.L.edge === 6, `front armholes detected at e2 (R) / e6 (L) — got R${fArm && fArm.R.edge}/L${fArm && fArm.L.edge}`);
  ok(bArm && bArm.R.edge === 2 && bArm.L.edge === 6, "back armholes detected at e2 (R) / e6 (L)");
  // CROSSED shoulders → front-R armhole pairs with back-L armhole (e6), front-L with back-R (e2).
  const mR = G.matchedBackArmhole(front, fArm.R.edge, back, bArm, seed.seams);
  const mL = G.matchedBackArmhole(front, fArm.L.edge, back, bArm, seed.seams);
  ok(mR && mR.edge === 6, `front-R armhole crosses to back e6 (got ${mR && mR.edge}) — same physical arm`);
  ok(mL && mL.edge === 2, `front-L armhole crosses to back e2 (got ${mL && mL.edge})`);
  // build the full sleeved doc the way addSleeve does (2 sleeves, 6 seams incl. 2 self-seams, notches).
  const pieces = [front, back], seams = seed.seams.slice();
  const usedId = new Set(pieces.map((p) => p.id));
  for (const side of ["R", "L"]) {
    const fA = fArm[side], bA = G.matchedBackArmhole(front, fA.edge, back, bArm, seed.seams) || bArm[side];
    const r = G.draftSleeve({ armholeFrontMm: fA.len, armholeBackMm: bA.len, bicepMm: Math.round(0.32 * 920), capEaseFrac: 0.06, side });
    const slv = r.piece; let c = 1; while (usedId.has("slv" + c)) c++; slv.id = "slv" + c; usedId.add(slv.id);
    pieces.push(slv);
    seams.push({ a: { piece: slv.id, edge: 3 }, b: { piece: front.id, edge: fA.edge }, ease: 0.06 });
    seams.push({ a: { piece: slv.id, edge: 2 }, b: { piece: back.id, edge: bA.edge }, ease: 0.06 });
    seams.push({ a: { piece: slv.id, edge: 1 }, b: { piece: slv.id, edge: 4 } });
    front.notches = (front.notches || []).concat([{ edge: fA.edge, t: 0.45, type: "single" }]);
    back.notches = (back.notches || []).concat([{ edge: bA.edge, t: 0.50, type: "double" }]);
  }
  const doc = G.freeformToDoc({ name: "Sleeved tank", body: G.DEFAULT_BODY, pieces, seams });
  ok(doc.pieces.length === 4, "doc has 4 pieces (front, back, 2 sleeves)");
  ok(doc.seams.length === 10, `all 10 seams survive (4 bodice + 6 sleeve) — got ${doc.seams.length}`);
  ok(doc.seams.filter((s) => s.a.piece === s.b.piece).length === 2, "two underarm SELF-seams survive normalizeSeams");
  ok(doc.pieces[0].notches.some((nt) => nt.type === "single") && doc.pieces[1].notches.some((nt) => nt.type === "double"),
     "bodice armholes got matching balance notches (single front / double back)");
  ok(doc.paths.every((p) => p.kind === "cut" || p.kind === "seam"), "sleeved tank lowers to only cut/seam line-kinds");
}

console.log("=== PRINT-SPINE SENTINEL: a drafted sleeve tiles to a 0-bad-page 1:1 Letter PDF ===");
{
  const r = G.draftSleeve({ armholeFrontMm: aF, armholeBackMm: aB, capEaseFrac: 0.06 });
  const doc = G.freeformToDoc({ name: "Sleeve test", pieces: [r.piece], body: G.DEFAULT_BODY });
  ok(doc.schema === 3, "doc with the sleeve is schema 3");
  ok(doc.paths.every((p) => p.kind === "cut" || p.kind === "seam"), "sleeve lowers to only cut/seam line-kinds (no new kinds)");
  const { bytes } = await P.makeTiledPdf(doc);
  const pdf = await PDFDocument.load(bytes);
  let bad = 0;
  for (const pg of pdf.getPages()) {
    const { width, height } = pg.getSize(), mb = pg.getMediaBox();
    if (Math.abs(width - 612) > 0.01 || Math.abs(height - 792) > 0.01 || (pg.getRotation().angle || 0) !== 0 || mb.x !== 0 || mb.y !== 0) bad++;
  }
  ok(bad === 0, `tiled sleeve PDF: ${pdf.getPageCount()} pages, ${bad} bad`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
