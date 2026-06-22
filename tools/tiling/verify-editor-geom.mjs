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

console.log("=== per-corner radius (Maker.js fillet, per node) ===");
{
  const plain = G.pieceGeom(G.rectPiece("Sq", 200, 200)).cut;
  ok(plain.length === 5, `un-rounded square has 5 cut pts (${plain.length})`);

  const one = G.rectPiece("Sq", 200, 200); one.nodes[0].radius = 10;   // one corner, no piece default
  const oneCut = G.pieceGeom(one).cut;
  ok(oneCut.length > 5, `one corner @10mm rounds (${oneCut.length} pts)`);
  const f = oneCut[0], l = oneCut[oneCut.length - 1];
  ok(approx(f[0], l[0]) && approx(f[1], l[1]), "rounded cut is closed");

  const all = G.rectPiece("Sq", 200, 200); all.cornerRadius = 10;       // piece default rounds all 4
  const allCut = G.pieceGeom(all).cut;
  ok(allCut.length > oneCut.length, `four corners @10mm > one corner (${allCut.length} > ${oneCut.length})`);

  const mix = G.rectPiece("Sq", 200, 200); mix.cornerRadius = 5; mix.nodes[2].radius = 40;   // node overrides default
  const mixCut = G.pieceGeom(mix).cut;
  ok(mixCut.length > 5 && approx(mixCut[0][0], mixCut[mixCut.length - 1][0]), "mixed default+override flattens, closed");

  await assertPages((await P.makeTiledPdf(G.freeformToDoc({ name: "Rounded", pieces: [one] }))).bytes, "per-corner rounded → tiler");
  console.log(`  per-corner radius OK — plain ${plain.length}, one ${oneCut.length}, all ${allCut.length} pts`);
}

console.log("=== SVG/DXF export (Maker.js exporters) ===");
{
  const doc = G.freeformToDoc({ name: "Exp", pieces: [G.rectPiece("A", 120, 80), G.rectPiece("B", 60, 200)] });
  const svg = G.exportBoard(doc, "svg");
  ok(typeof svg === "string" && svg.includes("<svg") && /<(path|line)/.test(svg), "exportBoard svg → an <svg> with geometry");
  const dxf = G.exportBoard(doc, "dxf");
  ok(typeof dxf === "string" && dxf.includes("ENTITIES") && dxf.includes("LINE"), "exportBoard dxf → ENTITIES/LINE");
  ok(G.exportBoard(null, "svg") === null, "exportBoard(null) → null");
  console.log(`  export OK — svg ${svg.length}b, dxf ${dxf.length}b`);
}

console.log("=== overlap predicate (board bboxes, mirrors editor.js) ===");
{
  const over = (a, b) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 0.5 && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > 0.5;
  const A = G.bbox([[0, 0], [100, 100]]);
  ok(over(A, G.bbox([[50, 50], [150, 150]])), "overlapping bboxes detected");
  ok(!over(A, G.bbox([[200, 0], [300, 100]])), "separated bboxes not flagged");
  ok(!over(A, G.bbox([[100, 0], [200, 100]])), "edge-touching bboxes not flagged");
  console.log("  overlap predicate OK");
}

console.log("=== M5a: garment authoring lowers to the print spine ===");
{
  const rectNodes = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

  // CURVES: a quad on an edge subdivides it (vs a straight chord) and the tiler accepts it.
  const curved = { id: "p", name: "Bodice", count: 1, seamMm: 0, closed: true,
    nodes: rectNodes(200, 300), edges: { "2": { curve: { type: "quad", cp: [0.5, 0.2] } } } };
  const cg = G.pieceGeom(curved);
  ok(cg.cut.length > 20, `curved edge subdivided (${cg.cut.length} pts vs 5 straight)`);
  // a quad Bézier apex reaches HALF the control-point offset: v·chord/2 = 0.2·200/2 = 20mm.
  const dev = Math.max(...cg.cut.filter((p) => p[0] > 30 && p[0] < 170).map((p) => Math.abs(p[1] - 300)));
  ok(approx(dev, 20, 1.5), `curve deflects v·chord/2 at apex (${dev.toFixed(1)}mm, expect ~20)`);
  // SAME flatten feeds print + drape: pieceGeom's cut IS what a curve consumer reads (one flatten)
  const cgsa = G.pieceGeom(Object.assign({}, curved, { seamMm: 10 }));
  ok(!!cgsa.seam && cgsa.seam.length > 20, "seam allowance offsets the curved outline too");
  await assertPages((await P.makeTiledPdf(G.freeformToDoc({ name: "Curve", pieces: [curved] }))).bytes, "curved bodice → tiler");

  // WEDGE DART: cut gains the apex + two legs; apex sits `depth` into the interior.
  const darted = { id: "p", name: "Front", count: 1, seamMm: 0, closed: true,
    nodes: rectNodes(200, 300), darts: [{ id: "d1", edge: 0, center: 0.5, width: 30, depth: 90, kind: "wedge" }] };
  const dg = G.pieceGeom(darted);
  ok(dg.cut.length === 8, `wedge dart adds 3 cut pts (rect 5 → ${dg.cut.length})`);
  const apexY = Math.max(...dg.cut.filter((p) => p[0] > 70 && p[0] < 130 && p[1] < 150).map((p) => p[1]));
  ok(approx(apexY, 90, 1), `dart apex at depth 90 into interior (${apexY.toFixed(1)})`);
  const lb = G.loweredBoundary(darted);
  ok(lb.dartLegs.length === 1 && Number.isInteger(lb.dartLegs[0].legA) && Number.isInteger(lb.dartLegs[0].legB),
     "loweredBoundary identifies the two dart-leg edges (M5c sews them shut)");
  ok(lb.dartFolds.length === 1, "wedge dart emits a stitch-guide centerline");
  // legs are equal length (isoceles) so the drape pairs them cleanly
  const ln = (i) => Math.hypot(lb.nodes[i + 1 >= lb.nodes.length ? 0 : i + 1].x - lb.nodes[i].x, lb.nodes[i + 1 >= lb.nodes.length ? 0 : i + 1].y - lb.nodes[i].y);
  ok(approx(ln(lb.dartLegs[0].legA), ln(lb.dartLegs[0].legB), 0.1), "dart legs equal length (clean pairing)");
  await assertPages((await P.makeTiledPdf(G.freeformToDoc({ name: "Dart", pieces: [darted] }))).bytes, "darted front → tiler");

  // VARIABLE per-node SA: inset is wider near a saMm node, default elsewhere.
  const varsa = G.pieceGeom({ id: "p", name: "Skirt", count: 1, seamMm: 10, closed: true,
    nodes: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300, saMm: 30 }, { x: 0, y: 300, saMm: 30 }] });
  const vbb = G.bbox(varsa.seam);
  ok(approx(vbb.maxY, 270, 0.5) && approx(vbb.minY, 10, 0.5), `variable SA: top inset 30, bottom inset 10 (${vbb.minY}..${vbb.maxY})`);
  // uniform-SA case stays byte-identical to the pre-change path (rectangle inset 10 all round)
  const uni = G.pieceGeom({ nodes: rectNodes(200, 300), seamMm: 10, closed: true });
  const ubb = G.bbox(uni.seam);
  ok(approx(ubb.minX, 10, 0.1) && approx(ubb.maxX, 190, 0.1) && approx(ubb.minY, 10, 0.1) && approx(ubb.maxY, 290, 0.1),
     "uniform SA unchanged (Maker outline path)");

  // UPGRADED notches {edge,t,type}: single = 1 tick, double = 2 ticks, placed at arc-length t.
  const nDoc = G.freeformToDoc({ name: "Notched", pieces: [{ id: "p", name: "N", count: 1, closed: true,
    nodes: rectNodes(200, 100), notches: [{ edge: 0, t: 0.5, type: "single" }, { edge: 1, t: 0.3, type: "double" }] }] });
  const nticks = nDoc.paths.filter((p) => p.kind === "cut" && p.points.length === 2);
  ok(nticks.length === 3, `single(1)+double(2) → 3 notch ticks (${nticks.length})`);
  await assertPages((await P.makeTiledPdf(nDoc)).bytes, "upgraded-notch piece → tiler");

  // SCHEMA bump + body passthrough: any schema-3 field → schema 3; body fills field defaults.
  const gdoc = G.freeformToDoc({ name: "Garment", pieces: [curved, darted], body: { bustMm: 900 } });
  ok(gdoc.schema === 3, "schema-3 field present → schema 3");
  ok(gdoc.body && gdoc.body.bustMm === 900 && gdoc.body.heightMm === 1650 && gdoc.body.hipMm === 980,
     "body passes through, absent fields default (1650/—/740/980)");
  const plain = G.freeformToDoc({ name: "Plain bag", pieces: [{ name: "P", nodes: rectNodes(200, 200) }] });
  ok(plain.schema === 2 && !plain.body, "a plain piece stays schema 2, no fabricated body");
  console.log("  garment authoring lowers cleanly — print spine accepts curves/darts/SA/notches");
}

console.log("=== Stage 0: edge-local inverse + edgeInwardSign + reindexEdgeRefs + body passthrough ===");
{
  const rectNodes = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

  // exports present
  ok(typeof G.edgeLocalToWorld === "function" && typeof G.worldToEdgeLocal === "function"
     && typeof G.reindexEdgeRefs === "function" && typeof G.edgeInwardSign === "function"
     && typeof G.migrateNotches === "function", "new geom helpers exported");

  // forward∘inverse + inverse∘forward identity for a few edges/cp
  let worst = 0;
  for (const [a, b] of [[{ x: 10, y: 20 }, { x: 210, y: 20 }], [{ x: 0, y: 0 }, { x: 100, y: 140 }], [{ x: -30, y: 5 }, { x: 12, y: -88 }]]) {
    for (const [u, v] of [[0.5, 0.2], [0.1, -0.4], [0.9, 0.0], [0.33, 1.0]]) {
      const Pw = G.edgeLocalToWorld(a, b, u, v);
      const uv = G.worldToEdgeLocal(a, b, { x: Pw[0], y: Pw[1] });
      worst = Math.max(worst, Math.abs(uv[0] - u), Math.abs(uv[1] - v));
      const w = { x: a.x + 0.4 * (b.x - a.x) - 7, y: a.y + 0.4 * (b.y - a.y) + 13 };   // raw world pt
      const back = G.edgeLocalToWorld(a, b, ...G.worldToEdgeLocal(a, b, w));
      worst = Math.max(worst, Math.abs(back[0] - w.x), Math.abs(back[1] - w.y));
    }
  }
  ok(worst < 1e-9, `edge-local forward/inverse round-trip worst ${worst.toExponential(2)}`);

  // inward sign: CCW rect top edge → +1, and a curve with that sign dips the apex toward the interior
  const rn = rectNodes(200, 300);
  ok(G.edgeInwardSign(rn, 2) === 1, "CCW rect top-edge inward sign = +1 (positive v bows inward)");
  const inwardCurve = { id: "p", name: "C", count: 1, closed: true, nodes: rn,
    edges: { "2": { curve: { type: "quad", cp: [0.5, 0.15 * G.edgeInwardSign(rn, 2)] } } } };
  const apexY = Math.min(...G.pieceGeom(inwardCurve).cut.filter((p) => p[0] > 60 && p[0] < 140).map((p) => p[1]));
  ok(apexY < 300 - 5, `sign-pin: inward curve apex dips below the chord (${apexY.toFixed(1)} < 300)`);

  // reindexEdgeRefs — a piece with a curve + dart + notch all on edge 2
  const mk = () => ({ id: "p", nodes: rectNodes(200, 300),
    edges: { "2": { curve: { type: "quad", cp: [0.5, 0.2] } } },
    darts: [{ id: "d1", edge: 2, center: 0.5, width: 20, depth: 40, kind: "wedge" }],
    notches: [{ edge: 2, t: 0.5, type: "single" }] });
  let pc = mk(); G.reindexEdgeRefs(pc, { kind: "insert", ei: 0 });
  ok(Object.keys(pc.edges)[0] === "3" && pc.darts[0].edge === 3 && pc.notches[0].edge === 3, "insert upstream shifts curve+dart+notch 2→3");
  pc = mk(); G.reindexEdgeRefs(pc, { kind: "insert", ei: 2 });
  ok(pc.edges["2"] && pc.darts[0].edge === 2 && pc.notches[0].edge === 2, "insert ON the edge keeps it at 2");
  pc = mk(); G.reindexEdgeRefs(pc, { kind: "delete", k: 0 });
  ok(pc.edges["1"] && pc.darts[0].edge === 1 && pc.notches[0].edge === 1, "delete upstream shifts 2→1");
  pc = mk(); G.reindexEdgeRefs(pc, { kind: "delete", k: 2 });
  ok(Object.keys(pc.edges).length === 0 && pc.darts.length === 0 && pc.notches.length === 0, "delete the edge drops curve+dart+notch on it");
  // reindexed refs survive normalizePieces (the exact restore() path)
  pc = mk(); G.reindexEdgeRefs(pc, { kind: "insert", ei: 0 });
  const cloned = G.normalizePieces({ pieces: [pc] })[0];
  ok(cloned.edges && cloned.edges["3"] && cloned.darts[0].edge === 3 && cloned.notches[0].edge === 3, "reindexed refs survive normalizePieces");

  // BODY passthrough (toggleGarment's two states) — on → schema 3 + defaults; off → schema 2, no body
  const onDoc = G.freeformToDoc({ name: "G", pieces: [{ name: "P", nodes: rectNodes(200, 200) }], body: Object.assign({}, G.DEFAULT_BODY) });
  ok(onDoc.schema === 3 && onDoc.body && onDoc.body.heightMm === 1650, "garment ON → schema 3 + body defaults");
  const offDoc = G.freeformToDoc({ name: "B", pieces: [{ name: "P", nodes: rectNodes(200, 200) }] });
  ok(offDoc.schema === 2 && !offDoc.body, "garment OFF → schema 2, no body");
  console.log("  Stage 0 + body OK");
}

console.log("=== M2: curve cp contract (cloneEdges) + cubic lowering ===");
{
  const rectNodes = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  // a UI-shaped cubic (4 cp) survives normalizePieces
  const cub = G.normalizePieces({ pieces: [{ id: "p", nodes: rectNodes(200, 300),
    edges: { "2": { curve: { type: "cubic", cp: [0.33, 0.2, 0.67, 0.2] } } } }] })[0];
  ok(cub.edges && cub.edges["2"] && cub.edges["2"].curve.type === "cubic" && cub.edges["2"].curve.cp.length === 4,
     "valid cubic (4 cp) survives normalizePieces");
  // a malformed cubic (2 cp) is DROPPED (cloneEdges needs >=4) — the editor's type-cycle MUST resize to avoid this
  const bad = G.normalizePieces({ pieces: [{ id: "p", nodes: rectNodes(200, 300),
    edges: { "2": { curve: { type: "cubic", cp: [0.5, 0.2] } } } }] })[0];
  ok(!bad.edges, "malformed cubic (2 cp) is dropped — the contract the type-cycle must honor");
  // a cubic curve lowers + tiles
  await assertPages((await P.makeTiledPdf(G.freeformToDoc({ name: "Cubic", pieces: [{ id: "p", name: "C", count: 1, closed: true, nodes: rectNodes(200, 300), edges: { "2": { curve: { type: "cubic", cp: [0.3, 0.18, 0.7, 0.18] } } } }] }))).bytes, "cubic curve → tiler");
  console.log("  M2 curve contract OK");
}

console.log("=== M3: dart placement contract (clonePiece floors + slash + cleanliness) ===");
{
  const rectNodes = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const wedge = (edge, extra) => ({ id: "d1", edge, center: 0.5, width: 26, depth: 90, kind: "wedge", ...extra });
  // a default dart on edge n-1 (edge 3) survives normalizePieces (not silently filtered)
  const onLast = G.normalizePieces({ pieces: [{ id: "p", nodes: rectNodes(200, 300), darts: [wedge(3)] }] })[0];
  ok(onLast.darts && onLast.darts.length === 1 && onLast.darts[0].edge === 3, "dart on edge n-1 survives normalizePieces");
  // width 0.5 → floored to 1 (matches the editor's wireDart clamp, so no undo snap)
  const tiny = G.normalizePieces({ pieces: [{ id: "p", nodes: rectNodes(200, 300), darts: [wedge(0, { width: 0.5 })] }] })[0];
  ok(tiny.darts[0].width === 1, `clonePiece floors width 0.5 → 1 (${tiny.darts[0].width})`);
  // slash dart → fold guide, NO extra cut points (rect stays 5 cut pts)
  const slashPiece = { id: "p", nodes: rectNodes(200, 300), darts: [{ id: "d1", edge: 0, center: 0.5, width: 26, depth: 90, kind: "slash" }] };
  ok(G.pieceGeom(slashPiece).cut.length === 5, `slash dart adds no cut points (${G.pieceGeom(slashPiece).cut.length})`);
  ok(G.loweredBoundary(slashPiece).dartFolds.length === 1, "slash dart emits a fold guide");
  await assertPages((await P.makeTiledPdf(G.freeformToDoc({ name: "Slash", pieces: [{ id: "p", name: "S", count: 1, closed: true, ...slashPiece }] }))).bytes, "slash dart → tiler");
  // a piece with no darts → schema 2, no darts key (deleteDart drops the empty array to keep it byte-clean)
  const noDart = G.freeformToDoc({ name: "Plain", pieces: [{ id: "p", name: "P", nodes: rectNodes(200, 200) }] });
  ok(noDart.schema === 2 && !noDart.pieces[0].darts, "piece with no darts → schema 2, no darts key");
  console.log("  M3 dart contract OK");
}

console.log("=== M4: notch upgrade (t = nearestEdge.proj.t + migration + double) ===");
{
  const ns = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }];
  // the t the editor stores on tap == nearestEdge(...).proj.t
  const ne = G.nearestEdge(ns, { x: 100, y: -3 });
  ok(ne.edge === 0 && approx(ne.proj.t, 0.5, 1e-9), `notch t = projection t on edge 0 (${ne.edge}, ${ne.proj.t})`);
  // migrateNotches: legacy {x,y} → {edge,t,type} matching nearestEdge
  const pc = { id: "p", nodes: ns, notches: [{ x: 150, y: 0 }] };
  G.migrateNotches(pc);
  ok(pc.notches[0].edge === 0 && approx(pc.notches[0].t, 0.75, 0.01) && pc.notches[0].type === "single",
     `legacy notch migrates to edge 0 t≈0.75 (${pc.notches[0].edge}, ${pc.notches[0].t})`);
  ok(G.notchTicks(ns, pc.notches[0]).length === 1, "migrated single → 1 tick");
  ok(G.notchTicks(ns, { edge: 1, t: 0.3, type: "double" }).length === 2, "double → 2 ticks");
  // a mixed-shape piece preserves BOTH notch shapes through normalizePieces (the restore() path)
  const mixed = G.normalizePieces({ pieces: [{ id: "p", nodes: ns, notches: [{ x: 150, y: 0 }, { edge: 1, t: 0.3, type: "double" }] }] })[0];
  ok(mixed.notches.length === 2 && mixed.notches[1].type === "double", "mixed legacy + upgraded notches both survive");
  console.log("  M4 notch upgrade OK");
}

console.log("=== M5: variable SA round-trip + curves-vs-SA caveat ===");
{
  // saMm:0 drops on clone (schema-2 byte-clean); saMm:25 round-trips
  const cl = G.normalizePieces({ pieces: [{ id: "p", nodes: [{ x: 0, y: 0, saMm: 0 }, { x: 200, y: 0 }, { x: 200, y: 100, saMm: 25 }, { x: 0, y: 100 }] }] })[0];
  ok(cl.nodes[0].saMm === undefined && cl.nodes[2].saMm === 25, "saMm:0 drops, saMm:25 round-trips");
  // a piece with BOTH curves AND node.saMm>0 → seam uses the UNIFORM Maker outline, NOT the per-node split
  const both = G.pieceGeom({ id: "p", seamMm: 10, closed: true,
    nodes: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300, saMm: 30 }, { x: 0, y: 300, saMm: 30 }],
    edges: { "0": { curve: { type: "quad", cp: [0.5, 0.1] } } } });
  ok(!!both.seam, "curved piece with variable SA still produces a seam line");
  const sb = G.bbox(both.seam);
  ok(approx(sb.maxY, 290, 2), `curves present → UNIFORM SA (top inset ~10 not 30): maxY ${sb.maxY.toFixed(1)} (would be ~270 if variable applied)`);
  console.log("  M5 variable SA caveat OK");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
