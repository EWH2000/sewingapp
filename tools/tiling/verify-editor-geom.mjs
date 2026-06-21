// Headless test for the freeform editor's pure geometry (app/static/js/pattern-geom.js).
// Mirrors verify-browser-gen.mjs: shim global.window, eval the browser modules, assert.
// The highest-value check is the round-trip: PatternGeom.freeformToDoc(params) must
// produce a document that the UNTOUCHED tiler (PatternPDF.makeTiledPdf) accepts without
// tripping its keep-out self-assertion — i.e. the editor only ever emits legal tiler input.
import * as PDFLib from "pdf-lib";
import makerjs from "makerjs";
import { readFileSync } from "node:fs";

global.window = { PDFLib, makerjs };     // pattern-geom reads window.makerjs for fillet/offset
const ROOT = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${ROOT}/pattern-pdf.js`, "utf8"));   // → window.PatternPDF
eval(readFileSync(`${ROOT}/pattern-geom.js`, "utf8"));  // → window.PatternGeom
const G = global.window.PatternGeom;
const P = global.window.PatternPDF;
const { PDFDocument } = PDFLib;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

async function assertPages(bytes, who) {
  const d = await PDFDocument.load(bytes);
  let bad = 0;
  for (const pg of d.getPages()) {
    const { width, height } = pg.getSize();
    const mb = pg.getMediaBox();
    if (Math.abs(width - 612) > 0.01 || Math.abs(height - 792) > 0.01 || (pg.getRotation().angle || 0) !== 0 || mb.x !== 0 || mb.y !== 0) bad++;
  }
  ok(bad === 0, `${who}: ${bad} bad pages`);
  console.log(`  ${who}: ${d.getPageCount()} pages — ${bad === 0 ? "PASS" : bad + " BAD"}`);
}

console.log("=== transform round-trip + y-flip ===");
{
  const cams = [
    { k: 2, tx: 50, ty: 600 }, { k: 0.37, tx: -120, ty: 940 }, { k: 11.2, tx: 3.1, ty: 77.9 },
  ];
  let worst = 0;
  for (const cam of cams) {
    for (const [x, y] of [[0, 0], [300, 400], [-12.5, 88.2], [1000, 7]]) {
      const s = G.worldToScreen(x, y, cam);
      const w = G.screenToWorld(s.sx, s.sy, cam);
      worst = Math.max(worst, Math.abs(w.x - x), Math.abs(w.y - y));
    }
  }
  ok(worst < 1e-9, `round-trip worst error ${worst}`);
  // y-flip: a larger world-y maps to a SMALLER screen-y
  const cam = { k: 3, tx: 10, ty: 500 };
  ok(G.worldToScreen(0, 100, cam).sy < G.worldToScreen(0, 0, cam).sy, "y-flip orientation");
  console.log(`  round-trip worst=${worst.toExponential(2)} — y-up confirmed`);
}

console.log("=== snap: grid, idempotency, no drift ===");
{
  ok(G.snap(4.9, 5) === 5, "snap 4.9→5");
  ok(G.snap(2.4, 5) === 0, "snap 2.4→0");
  ok(G.snap(7.5, 5) === 10, "snap 7.5→10");
  let v = 4.999999;
  for (let i = 0; i < 1000; i++) v = G.snap(v, 5);
  ok(v === 5, `idempotent snap stabilised at ${v}`);
  const sp = G.snapPoint({ x: 13.1, y: 27.6 }, 5);
  ok(sp.x === 15 && sp.y === 30, `snapPoint → ${sp.x},${sp.y}`);
  console.log("  snap stable + idempotent");
}

console.log("=== edgeLength / projection / pointToSegment ===");
{
  ok(approx(G.edgeLength([0, 0], [3, 4]), 5), "3-4-5 length");
  ok(approx(G.pointToSegmentDist([1, 1], [0, 0], [2, 0]), 1), "perp dist = 1");
  ok(approx(G.pointToSegmentDist([5, 0], [0, 0], [2, 0]), 3), "beyond-end dist = 3 (clamped)");
  const pr = G.projectPointOnSegment([1, 9], [0, 0], [2, 0]);
  ok(approx(pr.x, 1) && approx(pr.y, 0) && approx(pr.t, 0.5), `project t=${pr.t}`);
  console.log("  distances + projection correct");
}

console.log("=== bbox / insertVertexOnEdge / polylineToNodes ===");
{
  const bb = G.bbox([[10, 20], [40, 5], [25, 90]]);
  ok(bb.minX === 10 && bb.minY === 5 && bb.maxX === 40 && bb.maxY === 90 && bb.w === 30 && bb.h === 85, "bbox");
  const nodes = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const ins = G.insertVertexOnEdge(nodes, 0, { x: 5, y: 0 });   // split edge 0→1
  ok(ins.length === 5 && ins[1].x === 5 && ins[1].y === 0, "insert: n+1, collinear, ordered");
  const back = G.polylineToNodes([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  ok(back.length === 4 && back[0].x === 0 && back[3].y === 10, "polylineToNodes drops closing dup");
  console.log("  bbox + edit ops correct");
}

console.log("=== freeformToDoc: normalize + round-trip through the UNTOUCHED tiler ===");
{
  // a shape with negative coords — must normalize to origin (0,0)
  const params = {
    nodes: [{ x: -50, y: -20 }, { x: 250, y: -20 }, { x: 250, y: 380 }, { x: 80, y: 500 }, { x: -50, y: 380 }],
    seamMm: 10, gridMm: 5, closed: true, name: "Freeform test",
  };
  const doc = G.freeformToDoc(params);
  const allPts = doc.paths.flatMap((p) => p.points);
  const bb = G.bbox(allPts);
  ok(approx(bb.minX, 0) && approx(bb.minY, 0), `normalized to origin (${bb.minX},${bb.minY})`);
  ok(doc.widthMm === Math.ceil(bb.w) && doc.heightMm === Math.ceil(bb.h), "widthMm/heightMm = ceil(extent)");
  ok(doc.kind === "freeform" && Array.isArray(doc.pieces) && doc.pieces[0].nodes.length === 5, "legacy nodes → one editable piece");
  ok(doc.paths[0].kind === "cut" && doc.paths[0].points.length === 6, "cut path closed (n+1)");
  console.log(`  doc ${doc.widthMm}×${doc.heightMm}mm, ${doc.pieces.length} piece(s)`);
  const t = await P.makeTiledPdf(doc);   // must NOT throw the keep-out assertion
  console.log(`  tiled ${t.rows}×${t.cols}=${t.sheets} sheets`);
  await assertPages(t.bytes, "freeform→tiler");

  // a big shape that crosses several sheets, and the default blank
  const big = G.freeformToDoc({ nodes: [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 700 }, { x: 0, y: 700 }], closed: true });
  await assertPages((await P.makeTiledPdf(big)).bytes, "freeform big 3×3-ish");
  const blank = G.freeformToDoc(G.defaultParams());
  ok(blank.widthMm === 300 && blank.heightMm === 400, `default blank ${blank.widthMm}×${blank.heightMm}`);
  await assertPages((await P.makeTiledPdf(blank)).bytes, "default blank");
}

console.log("=== multi-piece: pieces[] pack + tile, and import from a tote ===");
{
  // three custom pieces (a "bag": body, side, pocket) → one packed layout
  const doc = G.freeformToDoc({
    name: "Bag", pieces: [
      { name: "Body", count: 2, nodes: G.rectPiece("", 300, 380).nodes },
      { name: "Side", count: 2, nodes: G.rectPiece("", 120, 380).nodes },
      { name: "Pocket", count: 1, nodes: [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 140 }, { x: 80, y: 180 }, { x: 0, y: 140 }] },
    ],
  });
  ok(doc.pieces.length === 3, "3 pieces carried in doc");
  ok(doc.paths.filter((p) => p.kind === "cut").length === 3, "3 cut paths packed");
  ok(doc.labels.length === 3 && /Body — cut 2/.test(doc.labels[0].lines[0]), "per-piece labels with cut count");
  // pieces must not overlap in the packed layout (bbox of each cut path disjoint-ish)
  await assertPages((await P.makeTiledPdf(doc)).bytes, "multi-piece bag");

  // round-trip: stored doc → normalizePieces → still 3 pieces editable
  const reloaded = G.normalizePieces(doc);
  ok(reloaded.length === 3 && reloaded[2].name === "Pocket", "normalizePieces round-trips stored doc");

  // import a generated boxy tote as editable freeform pieces
  const tote = P.boxyTotePattern("Tote", { widthMm: 350, heightMm: 400, depthMm: 120, seamMm: 10, strapLenMm: 600, strapWidthMm: 25 });
  const imported = G.piecesFromDoc(tote);
  const cutCount = tote.paths.filter((p) => p.kind === "cut").length;
  ok(imported.length === cutCount && imported.length >= 4, `imported ${imported.length} pieces from tote`);
  ok(imported.some((p) => /Strap/i.test(p.name) && p.count === 2), "tote import keeps names + cut counts");
  const rebuilt = G.freeformToDoc({ name: "Tote copy", pieces: imported });
  await assertPages((await P.makeTiledPdf(rebuilt)).bytes, "tote→freeform→tiler");
  console.log(`  imported tote pieces: ${imported.map((p) => p.name + "×" + p.count).join(", ")}`);
}

console.log("=== step 3: seam-allowance offset + rounded corners (Maker.js) ===");
{
  // seam allowance == analytic inset for a rectangle
  const sg = G.pieceGeom({ nodes: G.rectPiece("", 200, 300).nodes, seamMm: 10, cornerRadius: 0, closed: true });
  ok(!!sg.seam, "seam line produced");
  const sbb = G.bbox(sg.seam), cbb = G.bbox(sg.cut);
  ok(approx(cbb.minX, 0) && approx(cbb.maxX, 200) && approx(cbb.maxY, 300), "cut bbox unchanged 200×300");
  ok(approx(sbb.minX, 10, 0.1) && approx(sbb.minY, 10, 0.1) && approx(sbb.maxX, 190, 0.1) && approx(sbb.maxY, 290, 0.1), `seam = inset 10 → [${sbb.minX},${sbb.minY}]..[${sbb.maxX},${sbb.maxY}]`);
  console.log(`  inset OK: seam ${sbb.maxX - sbb.minX}×${sbb.maxY - sbb.minY} mm`);

  // rounded corners: a 200×300 rect, radius 20
  const rg = G.pieceGeom({ nodes: G.rectPiece("", 200, 300).nodes, seamMm: 0, cornerRadius: 20, closed: true });
  ok(rg.cut.length > 12, `rounded cut subdivided (${rg.cut.length} pts)`);
  const rbb = G.bbox(rg.cut);
  ok(approx(rbb.minX, 0, 0.2) && approx(rbb.maxX, 200, 0.2) && approx(rbb.maxY, 300, 0.2), "rounded cut keeps the 200×300 envelope");
  // no cut point sits in the squared-off corner — the corner is rounded away
  const distToCorner = Math.min(...rg.cut.map((p) => Math.hypot(p[0], p[1])));
  ok(distToCorner > 4, `corner rounded away (nearest cut pt ${distToCorner.toFixed(1)}mm from corner)`);
  // chord fidelity: each rounded-corner sample within tolerance of radius 20 arc
  // (corner arc centre is at (20,20) for the bottom-left corner)
  const near = rg.cut.filter((p) => p[0] < 20 && p[1] < 20);
  const maxErr = Math.max(0, ...near.map((p) => Math.abs(Math.hypot(p[0] - 20, p[1] - 20) - 20)));
  ok(maxErr < 0.35, `fillet chord error ${maxErr.toFixed(3)}mm ≤ tol`);
  console.log(`  fillet OK: ${rg.cut.length} pts, max chord err ${maxErr.toFixed(3)}mm`);

  // a full piece with BOTH rounded corners and seam allowance → tiler accepts
  const doc = G.freeformToDoc({ name: "Rounded pocket", pieces: [{ name: "Pocket", count: 1, cornerRadius: 25, seamMm: 10, nodes: G.rectPiece("", 220, 180).nodes }] });
  ok(doc.paths.some((p) => p.kind === "cut") && doc.paths.some((p) => p.kind === "seam"), "doc has cut + seam paths");
  await assertPages((await P.makeTiledPdf(doc)).bytes, "rounded+SA piece → tiler");

  // multi-piece bag with SA everywhere
  const bag = G.freeformToDoc({ name: "Bag", pieces: [
    { name: "Body", count: 2, seamMm: 12, cornerRadius: 15, nodes: G.rectPiece("", 300, 360).nodes },
    { name: "Side", count: 2, seamMm: 12, nodes: G.rectPiece("", 110, 360).nodes },
    { name: "Base", count: 1, seamMm: 12, cornerRadius: 10, nodes: G.rectPiece("", 300, 110).nodes },
  ] });
  ok(bag.paths.filter((p) => p.kind === "seam").length === 3, "every piece got a seam line");
  await assertPages((await P.makeTiledPdf(bag)).bytes, "multi-piece bag + seam allowance");

  // guard: seam allowance too large for the shape → no seam (not a bad polygon)
  const tiny = G.pieceGeom({ nodes: G.rectPiece("", 40, 40).nodes, seamMm: 30, cornerRadius: 0, closed: true });
  ok(!tiny.seam, "over-large seam allowance → seam omitted (guarded)");
  console.log("  combined + multi-piece + guard OK");
}

console.log("=== notches + pocket-placement guides ===");
{
  const doc = G.freeformToDoc({ name: "Annotated", pieces: [
    { name: "Body", count: 2, nodes: G.rectPiece("", 300, 380).nodes,
      notches: [{ x: 150, y: 0 }, { x: 300, y: 190 }],
      placements: [{ x: 70, y: 120, w: 160, h: 150, label: "Front pocket" }] },
  ] });
  const ticks = doc.paths.filter((p) => p.kind === "cut" && p.points.length === 2);
  ok(ticks.length === 2, `2 notch ticks emitted (${ticks.length})`);
  const seamRects = doc.paths.filter((p) => p.kind === "seam" && p.points.length === 5);
  ok(seamRects.length === 1, "placement rect emitted (seam-style guide)");
  ok(doc.labels.some((l) => l.lines[0] === "Front pocket"), "placement label emitted");
  const len = Math.hypot(ticks[0].points[1][0] - ticks[0].points[0][0], ticks[0].points[1][1] - ticks[0].points[0][1]);
  ok(Math.abs(len - 7) < 0.1, `notch tick ≈7mm (${len.toFixed(1)})`);
  await assertPages((await P.makeTiledPdf(doc)).bytes, "annotated piece → tiler");

  // notchMark re-projects a stored point onto the nearest edge (robust to edits)
  const m = G.notchMark(G.rectPiece("", 100, 100).nodes, { x: 48, y: -5 });
  const mid = [(m[0][0] + m[1][0]) / 2, (m[0][1] + m[1][1]) / 2];
  ok(approx(mid[1], 0) && approx(mid[0], 48), `notch snaps to nearest edge → (${mid[0]},${mid[1]})`);
  console.log("  notches + placement OK");
}

console.log("=== board layout: packLayouts + WYSIWYG freeformToDoc ===");
{
  // packLayouts gives every piece a layout, and the cells don't overlap
  const ps = [G.rectPiece("A", 200, 200), G.rectPiece("B", 200, 200), G.rectPiece("C", 200, 200)];
  G.packLayouts(ps);
  ok(ps.every((p) => p.layout && isFinite(p.layout.x) && isFinite(p.layout.y)), "every piece got a layout");
  // board rects (local bbox 0..200 + layout) must be pairwise non-overlapping
  const rects = ps.map((p) => ({ x0: p.layout.x, y0: p.layout.y, x1: p.layout.x + 200, y1: p.layout.y + 200 }));
  let overlap = false;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlap = true;
  }
  ok(!overlap, "packed pieces don't overlap");

  // explicit layout is honored (WYSIWYG): two pieces at chosen offsets
  const doc = G.freeformToDoc({ name: "Board", pieces: [
    { name: "P1", nodes: G.rectPiece("", 100, 100).nodes, layout: { x: 0, y: 0 } },
    { name: "P2", nodes: G.rectPiece("", 100, 100).nodes, layout: { x: 300, y: 50 } },
  ] });
  ok(doc.widthMm === 400 && doc.heightMm === 150, `board bbox honors layout → ${doc.widthMm}×${doc.heightMm} (expect 400×150)`);
  // the two cut paths sit ~300mm apart in x (gap between the pieces preserved)
  const cuts = doc.paths.filter((p) => p.kind === "cut").map((p) => G.bbox(p.points));
  const gapX = Math.abs(cuts[1].minX - cuts[0].minX);
  ok(approx(gapX, 300, 0.5), `pieces kept 300mm apart (${gapX.toFixed(1)})`);
  // output pieces carry shifted layout matching the normalized board (origin 0,0)
  ok(doc.pieces[0].layout.x === 0 && doc.pieces[0].layout.y === 0, "normalized: first piece layout at origin");
  await assertPages((await P.makeTiledPdf(doc)).bytes, "WYSIWYG board → tiler");

  // layout-less pieces still pack + tile (back-compat)
  const legacy = G.freeformToDoc({ pieces: [{ name: "X", nodes: G.rectPiece("", 250, 300).nodes }, { name: "Y", nodes: G.rectPiece("", 250, 300).nodes }] });
  ok(legacy.pieces.every((p) => p.layout), "layout-less doc gets packed layouts");
  await assertPages((await P.makeTiledPdf(legacy)).bytes, "legacy (no layout) → tiler");
  console.log(`  board layout OK — board ${doc.widthMm}×${doc.heightMm}mm`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
