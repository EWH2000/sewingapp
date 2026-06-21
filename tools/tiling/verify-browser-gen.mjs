// Run the browser module (app/static/js/pattern-pdf.js) under Node by shimming
// window.PDFLib, so we can verify the tote/rectangle/calibration geometry headless.
import * as PDFLib from "pdf-lib";
import { readFileSync } from "node:fs";
global.window = { PDFLib };
eval(readFileSync("/home/ehill/sewingapp/app/static/js/pattern-pdf.js", "utf8"));
const P = global.window.PatternPDF;
const { PDFDocument } = PDFLib;

async function assertPages(bytes, who) {
  const d = await PDFDocument.load(bytes);
  let bad = 0;
  for (const pg of d.getPages()) {
    const { width, height } = pg.getSize();
    const mb = pg.getMediaBox();
    if (Math.abs(width - 612) > 0.01 || Math.abs(height - 792) > 0.01 || (pg.getRotation().angle || 0) !== 0 || mb.x !== 0 || mb.y !== 0) bad++;
  }
  console.log(`  ${who}: ${d.getPageCount()} pages, ${bad === 0 ? "all 612x792 rot0 origin0 — PASS" : bad + " BAD pages — FAIL"}`);
  return bad === 0;
}

console.log("=== boxy tote (350x400x120mm, SA10, strap 600x25) ===");
const tote = P.boxyTotePattern("Test tote", { widthMm: 350, heightMm: 400, depthMm: 120, seamMm: 10, strapLenMm: 600, strapWidthMm: 25 });
console.log(`  layout ${tote.widthMm}x${tote.heightMm}mm; ${tote.paths.length} paths, ${tote.labels.length} labels`);
const t = await P.makeTiledPdf(tote);
console.log(`  tiled ${t.rows}x${t.cols}=${t.sheets} sheets (+map); ${t.bytes.length} bytes`);
const ok1 = await assertPages(t.bytes, "tote");

console.log("=== regression: rectangle + calibration ===");
const r = await P.makeTiledPdf(P.rectanglePattern("r", 300, 380));
const ok2 = await assertPages(r.bytes, "rectangle 2x2");
const cal = await P.makeCalibrationPdf();
const ok3 = await assertPages(cal, "calibration");

// edge cases: a 1xN (tall thin) and a small tote that should be few sheets
console.log("=== edge: tall-thin rectangle (single column) + tiny tote ===");
const tall = await P.makeTiledPdf(P.rectanglePattern("tall", 120, 900));
console.log(`  tall: ${tall.rows}x${tall.cols}=${tall.sheets}`); const ok4 = await assertPages(tall.bytes, "tall");
const tiny = await P.makeTiledPdf(P.boxyTotePattern("tiny", { widthMm: 150, heightMm: 150, depthMm: 60, seamMm: 10, strapLenMm: 300, strapWidthMm: 20 }));
console.log(`  tiny tote: ${tiny.rows}x${tiny.cols}=${tiny.sheets}`); const ok5 = await assertPages(tiny.bytes, "tiny tote");

console.log("\n" + ([ok1,ok2,ok3,ok4,ok5].every(Boolean) ? "ALL PASS" : "SOME FAILED"));
