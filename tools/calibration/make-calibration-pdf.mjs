// Phase-1 de-risk: prove TRUE 1:1 print scale survives the real printer/driver
// BEFORE building any UI, container, or storage. (See ../../DESIGN.md, the
// "Print contract" section, and ~/sewing-pattern-tool-handoff.md.)
//
// This emits one US-Letter PDF whose geometry is placed at EXACT PostScript
// points (pdf-lib: 72 pt = 1 inch, origin bottom-left). If the user prints it
// at "Actual Size / 100%" (NOT Fit-to-Page) and the marks measure true, then a
// generated PDF is a trustworthy scale mechanism and the whole approach is sound.
//
//   run:  node make-calibration-pdf.mjs   ->   writes calibration.pdf
//
// Why a ruler AND a square: a single 1-inch square hides a small percentage
// scaling error (1% of 1 inch = 0.25 mm, easy to miss). A 6-inch span makes the
// same 1% error a visible 1.5 mm, so a long ruler is the sensitive test; the
// square is the quick eyeball check.

import { PDFDocument, rgb, StandardFonts, LineCapStyle } from "pdf-lib";
import { writeFileSync } from "node:fs";

// ── unit helpers (everything below is authored in points) ──────────────────
const IN = 72;              // points per inch        (exact, by PDF definition)
const MM = 72 / 25.4;       // points per millimeter   (~2.83465)
const CM = 10 * MM;         // points per centimeter

const PAGE_W = 8.5 * IN;    // 612 pt — US Letter, portrait
const PAGE_H = 11 * IN;     // 792 pt
const SAFE = 13 * MM;       // keep critical marks >=13mm from edges (hw margins)

const INK = rgb(0.1, 0.11, 0.13);
const RED = rgb(0.83, 0.18, 0.18);
const MUTED = rgb(0.42, 0.44, 0.48);

const doc = await PDFDocument.create();
const page = doc.addPage([PAGE_W, PAGE_H]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

// pdf-lib y-origin is the bottom; author top-down with a descending cursor.
let top = PAGE_H - SAFE;

const text = (s, x, y, size, f = font, color = INK) =>
  page.drawText(s, { x, y, size, font: f, color });

// ── title + the all-important instruction ──────────────────────────────────
text("Sewing — 1:1 print calibration", SAFE, top - 14, 16, bold);
top -= 30;
text("PRINT AT 100% / ACTUAL SIZE — NOT \"Fit to Page\" / \"Shrink to fit\".",
  SAFE, top - 11, 11, bold, RED);
top -= 16;
text("Adobe Reader: Page Sizing & Handling -> Actual Size.  Browser: Scale 100%, Margins None.",
  SAFE, top - 10, 9.5, font, MUTED);
top -= 14;
text("Then measure the marks below with a ruler. Tolerance +/- 1 mm. If anything", SAFE, top - 10, 9.5, font, MUTED);
top -= 12;
text("reads short/long, a scaling setting is on — fix it and reprint before using real patterns.", SAFE, top - 10, 9.5, font, MUTED);
top -= 26;

// ── 1-inch square + 5 cm square, side by side (quick eyeball check) ─────────
const squareTopY = top;
// 1 inch square
const sqIn = IN;
page.drawRectangle({ x: SAFE, y: squareTopY - sqIn, width: sqIn, height: sqIn,
  borderColor: INK, borderWidth: 1 });
text("1 inch", SAFE + 6, squareTopY - sqIn / 2 - 4, 9, bold);
text("(25.4 mm)", SAFE + 4, squareTopY - sqIn / 2 - 16, 8, font, MUTED);

// 5 cm square
const sqCm = 5 * CM;
const cmX = SAFE + sqIn + 28 * MM;
page.drawRectangle({ x: cmX, y: squareTopY - sqCm, width: sqCm, height: sqCm,
  borderColor: INK, borderWidth: 1 });
text("5 cm", cmX + 6, squareTopY - sqCm / 2 - 4, 9, bold);
text("(1.969 in)", cmX + 4, squareTopY - sqCm / 2 - 16, 8, font, MUTED);

top = squareTopY - sqCm - 34;

// ── horizontal ruler helper ─────────────────────────────────────────────────
// Draws a baseline of `lengthPt`, with major ticks down from it every `majorPt`
// (labeled 0..n) and minor ticks every `minorPt`. Measuring end-to-end across
// the whole baseline is the sensitive long-span scale check.
function ruler({ x, y, lengthPt, majorPt, minorPt, label, unitName }) {
  // baseline
  page.drawLine({ start: { x, y }, end: { x: x + lengthPt, y },
    thickness: 1, color: INK, lineCap: LineCapStyle.Butt });
  const majorH = 9 * MM, minorH = 4.5 * MM;
  // minor ticks
  for (let p = 0; p <= lengthPt + 0.01; p += minorPt) {
    page.drawLine({ start: { x: x + p, y }, end: { x: x + p, y: y - minorH },
      thickness: 0.5, color: MUTED });
  }
  // major ticks + numeric labels
  let n = 0;
  for (let p = 0; p <= lengthPt + 0.01; p += majorPt, n++) {
    page.drawLine({ start: { x: x + p, y }, end: { x: x + p, y: y - majorH },
      thickness: 1, color: INK });
    text(String(n), x + p - 2.5, y - majorH - 10, 8, font, INK);
  }
  text(label, x, y + 6, 9.5, bold);
  text(unitName, x + lengthPt - 26, y + 6, 8, font, MUTED);
}

// 6-inch ruler: across the whole baseline should measure exactly 6.000 in.
ruler({ x: SAFE, y: top, lengthPt: 6 * IN, majorPt: IN, minorPt: IN / 2,
  label: "6-inch ruler  (end-to-end = 6.000 in)", unitName: "inches" });
top -= 30 * MM;

// 15-cm ruler: across the whole baseline should measure exactly 15.0 cm.
ruler({ x: SAFE, y: top, lengthPt: 15 * CM, majorPt: CM, minorPt: 5 * MM,
  label: "15-cm ruler  (end-to-end = 15.0 cm)", unitName: "cm" });
top -= 30 * MM;

// ── seam-allowance gauge: parallel lines at common SA distances ─────────────
// A sanity check for the offset distances real patterns use. Measuring between
// the base line and each labeled line confirms small distances print true too.
const gaugeX = SAFE, gaugeBaseY = top - 4;
const gaugeLen = 5 * IN;
const offsets = [
  { mm: 0, lbl: "edge" },
  { mm: 6, lbl: "6 mm (1/4\")" },
  { mm: 10, lbl: "10 mm (3/8\")" },
  { mm: 15, lbl: "15 mm (5/8\")" },
];
text("Seam-allowance gauge  (measure base->line = the labeled distance)", gaugeX, gaugeBaseY + 8, 9.5, bold);
for (const o of offsets) {
  const yy = gaugeBaseY - o.mm * MM;
  page.drawLine({ start: { x: gaugeX, y: yy }, end: { x: gaugeX + gaugeLen, y: yy },
    thickness: o.mm === 0 ? 1 : 0.75, color: o.mm === 0 ? INK : RED });
  text(o.lbl, gaugeX + gaugeLen + 6, yy - 3, 8, font, MUTED);
}

// ── footer ──────────────────────────────────────────────────────────────────
text("Phase-1 calibration  ·  US Letter 612x792 pt  ·  72 pt/in  ·  generated by tools/calibration/make-calibration-pdf.mjs",
  SAFE, SAFE - 2, 7.5, font, MUTED);

const bytes = await doc.save();
writeFileSync(new URL("calibration.pdf", import.meta.url), bytes);
console.log("wrote calibration.pdf  (%d bytes)", bytes.length);
