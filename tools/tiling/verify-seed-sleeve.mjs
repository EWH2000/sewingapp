// verify-seed-sleeve.mjs — the seeded "Sleeved Tank" (id8) is a real set-in-sleeve fixture: it
// lowers to a 0-bad-page 1:1 Letter PDF (the print-spine sentinel), every cap↔armhole seam carries
// the authored ease (cap edge LONGER than the armhole, bounded), the underarm self-seams zip (their
// two edges match), and the bodice armholes gained matching balance notches. Imports the seed's
// sleevedTank() builder (its POST is entry-point-guarded, so importing is side-effect-free).
//   cd ~/sewingapp/tools/tiling && node verify-seed-sleeve.mjs
import * as PDFLib from "pdf-lib";
import { readFileSync } from "node:fs";
import { sleevedTank, G } from "../seed-examples.mjs";   // sets global.window={makerjs}, evals pattern-geom

global.window.PDFLib = PDFLib;
eval(readFileSync("/home/ehill/sewingapp/app/static/js/pattern-pdf.js", "utf8"));   // → window.PatternPDF
const P = global.window.PatternPDF;
const { PDFDocument } = PDFLib;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

const seed = sleevedTank();
const byId = {}; seed.pieces.forEach((p) => { byId[p.id] = p; });
const arc = (pid, e) => G.edgeArcLenMm(byId[pid], e);

console.log("=== structure: bodice + 2 sleeves + 10 seams (2 self-seams) ===");
{
  ok(seed.pieces.length === 4, `4 pieces (front, back, 2 sleeves) — got ${seed.pieces.length}`);
  const sleeves = seed.pieces.filter((p) => p.place3d && p.place3d.role === "sleeve");
  ok(sleeves.length === 2 && sleeves.every((s) => s.nodes.length === 5), "two 5-node sleeve pieces tagged place3d.role='sleeve'");
  ok(seed.seams.length === 10, `10 seams (4 bodice + 6 sleeve) — got ${seed.seams.length}`);
  ok(seed.seams.filter((s) => s.a.piece === s.b.piece).length === 2, "two underarm SELF-seams (a.piece === b.piece)");
}

console.log("=== cap↔armhole seams carry ease (cap edge longer than armhole, bounded) ===");
{
  let perSleeveOk = true;
  for (const side of ["R", "L"]) {
    const slv = "st_slv_" + side;
    const capSeams = seed.seams.filter((s) => s.a.piece === slv && s.a.piece !== s.b.piece);
    ok(capSeams.length === 2, `${side}: two cap↔armhole seams`);
    let capSum = 0, armSum = 0;
    for (const s of capSeams) {
      const cap = arc(s.a.piece, s.a.edge), arm = arc(s.b.piece, s.b.edge);
      capSum += cap; armSum += arm;
      ok(s.ease === 0.06, `${side}: cap seam carries ease 0.06`);
      ok(cap >= arm - 0.5 && cap <= arm * 1.25, `${side}: cap edge (${cap.toFixed(0)}) ≥ armhole (${arm.toFixed(0)}) and bounded (ease, not blow-up)`);
    }
    // the draft matched the TOTAL cap to the TOTAL armhole × (1+ease).
    ok(Math.abs(capSum - armSum * 1.06) < 1.5, `${side}: total cap ${capSum.toFixed(1)} = armhole ${armSum.toFixed(1)} × 1.06 (within 1.5mm)`);
    if (Math.abs(capSum - armSum * 1.06) >= 1.5) perSleeveOk = false;
  }
  ok(perSleeveOk, "both sleeve caps eased onto their armholes");
}

console.log("=== underarm self-seam edges match (the tube zips) ===");
{
  for (const s of seed.seams.filter((x) => x.a.piece === x.b.piece)) {
    const la = arc(s.a.piece, s.a.edge), lb = arc(s.b.piece, s.b.edge);
    ok(Math.abs(la - lb) <= 2, `${s.a.piece}: underarm e${s.a.edge}(${la.toFixed(0)}) ↔ e${s.b.edge}(${lb.toFixed(0)}) match within 2mm`);
  }
}

console.log("=== bodice armholes gained matching balance notches (single front / double back) ===");
{
  const front = byId["st_bf"], back = byId["st_bb"];
  ok((front.notches || []).filter((n) => n.type === "single").length === 2, "front got 2 single armhole notches (one per arm)");
  ok((back.notches || []).filter((n) => n.type === "double").length === 2, "back got 2 double armhole notches");
}

console.log("=== PRINT-SPINE SENTINEL: id8 lowers to a 0-bad-page 1:1 Letter PDF ===");
{
  const doc = G.freeformToDoc({ name: seed.name, pieces: seed.pieces, seams: seed.seams, body: seed.body, gridMm: 5 });
  ok(doc.schema === 3, `schema 3 (got ${doc.schema})`);
  ok(doc.seams.length === seed.seams.length, `all ${seed.seams.length} seams carried into the doc`);
  ok(doc.paths.every((p) => p.kind === "cut" || p.kind === "seam"), "only cut/seam line-kinds (print spine untouched)");
  const { bytes, sheets } = await P.makeTiledPdf(doc);
  const pdf = await PDFDocument.load(bytes);
  let bad = 0;
  for (const pg of pdf.getPages()) {
    const { width, height } = pg.getSize(), mb = pg.getMediaBox();
    if (Math.abs(width - 612) > 0.01 || Math.abs(height - 792) > 0.01 || (pg.getRotation().angle || 0) !== 0 || mb.x !== 0 || mb.y !== 0) bad++;
  }
  ok(bad === 0, `tiled sleeved-tank PDF: ${pdf.getPageCount()} pages (${sheets || "?"} sheets), ${bad} bad`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
