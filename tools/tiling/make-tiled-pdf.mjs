// Multi-page tiled US-Letter PDF generator (DESIGN.md build-step 1b).
// Turns a pattern (polylines in real mm) into an N-sheet Letter PDF that prints
// 1:1 via the proven ipp-print path (print-scaling=none). Spec: ./SPEC.md.
//
//   node make-tiled-pdf.mjs            -> tiled.pdf   (2x2 PROOF shape, 4 sheets)
//   node make-tiled-pdf.mjs --full     -> tiled.pdf   (700x500mm, 12 sheets)
//
// Design invariants (asserted at the end; the build FAILS rather than emit a bad PDF):
//  - every page MediaBox is EXACTLY [0,0,612,792]pt, /Rotate 0, CropBox==MediaBox
//  - all ink stays inside the 13mm hardware-margin keep-out
//  - tiles overlap by exactly 0.5in; alignment marks at band centers COINCIDE on
//    neighbouring sheets (proven by construction: a band-center global coordinate
//    lies inside both neighbours' content windows, so it is drawn on both).

import { PDFDocument, rgb, StandardFonts, LineCapStyle } from "pdf-lib";
import { writeFileSync } from "node:fs";

// ── units ───────────────────────────────────────────────────────────────────
const IN = 72;
const MM = 72 / 25.4;                 // ~2.83465 pt/mm
const PAGE_W = 8.5 * IN, PAGE_H = 11 * IN;     // 612 x 792
const SAFE = 13 * MM;                 // hardware-margin keep-out (probed 4.23mm; 13 is generous)
const OVERLAP = 0.5 * IN;             // 36pt shared band between adjacent tiles
const usableW = PAGE_W - 2 * SAFE;    // printable content window per sheet
const usableH = PAGE_H - 2 * SAFE;
const stepX = usableW - OVERLAP;      // unique advance per column
const stepY = usableH - OVERLAP;

const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.55, 0.57, 0.6);
const WHITE = rgb(1, 1, 1);

// ── line styles (mono-laser safe: cut is BLACK long-dash, never red) ──────────
const STYLE = {
  cut:  { color: BLACK, thickness: 1.1, dashArray: [11, 4] },     // long-dash = CUT
  fold: { color: BLACK, thickness: 0.9, dashArray: [8, 3, 1.2, 3] }, // dash-dot = FOLD
  seam: { color: BLACK, thickness: 0.5, dashArray: [3, 3] },
};

// ── the pattern (polylines in mm; origin bottom-left). First build = test shape ──
function testPattern(full) {
  const W = full ? 700 : 300, H = full ? 500 : 380;
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  return {
    name: full ? "Test 700x500" : "Tile proof 300x380",
    widthMm: W, heightMm: H,
    paths: [
      { kind: "cut",  points: rect(0, 0, W, H) },                 // outer cut boundary
      { kind: "cut",  points: rect(30, 30, W - 30, H - 30) },     // inner cut outline
      { kind: "fold", points: [[0, 0], [W, H]] },                 // diagonal X — crosses every seam,
      { kind: "fold", points: [[0, H], [W, 0]] },                 //   makes any misregistration obvious
    ],
  };
}

// ── Liang-Barsky: clip segment (gx0,gy0)-(gx1,gy1) to rect [xmin,xmax,ymin,ymax] ──
function clipSeg(x0, y0, x1, y1, xmin, xmax, ymin, ymax) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy], q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }               // parallel & outside
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else          { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

// ── build ─────────────────────────────────────────────────────────────────────
const full = process.argv.includes("--full");
const pat = testPattern(full);
const Wpt = pat.widthMm * MM, Hpt = pat.heightMm * MM;
const cols = Math.max(1, Math.ceil((Wpt - OVERLAP) / stepX));
const rows = Math.max(1, Math.ceil((Hpt - OVERLAP) / stepY));

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const fontB = await doc.embedFont(StandardFonts.HelveticaBold);

// track every inked sheet coordinate so we can assert the keep-out is respected
let inkMinX = 1e9, inkMinY = 1e9, inkMaxX = -1e9, inkMaxY = -1e9;
const ink = (x, y) => { inkMinX = Math.min(inkMinX, x); inkMinY = Math.min(inkMinY, y); inkMaxX = Math.max(inkMaxX, x); inkMaxY = Math.max(inkMaxY, y); };

const tileLabel = (r, c) => String.fromCharCode(65 + r) + (c + 1);

function drawSeg(page, sx0, sy0, sx1, sy1, st) {
  page.drawLine({ start: { x: sx0, y: sy0 }, end: { x: sx1, y: sy1 },
    thickness: st.thickness, color: st.color, dashArray: st.dashArray, lineCap: LineCapStyle.Butt });
  ink(sx0, sy0); ink(sx1, sy1);
}
function label(page, s, x, y, size, f = font, color = BLACK, halo = true) {
  if (halo) {
    const w = f.widthOfTextAtSize(s, size);
    page.drawRectangle({ x: x - 2, y: y - 2, width: w + 4, height: size + 2, color: WHITE, opacity: 0.85 });
  }
  page.drawText(s, { x, y, size, font: f, color });
  ink(x, y); ink(x + f.widthOfTextAtSize(s, size), y + size);
}
function outlineTri(page, x0, y0, x1, y1, x2, y2) {
  const t = 1.1;                                       // stroke only — hollow triangle
  page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: t, color: BLACK });
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: BLACK });
  page.drawLine({ start: { x: x2, y: y2 }, end: { x: x0, y: y0 }, thickness: t, color: BLACK });
  ink(Math.min(x0, x1, x2), Math.min(y0, y1, y2));
  ink(Math.max(x0, x1, x2), Math.max(y0, y1, y2));
}
// Registration mark: a PAIR of hollow (outline) triangles whose tips meet (with a
// hair gap) ON the alignment line — the convention on the commercial tiled
// patterns she uses. axis 'v' = mark sits on a vertical line (tips point
// left/right at it); 'h' = horizontal line (tips point up/down). Both neighbour
// sheets render the identical mark at the same global point, so they coincide
// when overlapped. (h = tip length, w = base half-width.)
function regMark(page, cx, cy, axis, h = 10, w = 7, gap = 1.8) {
  if (axis === "v") {
    outlineTri(page, cx - gap, cy, cx - gap - h, cy - w, cx - gap - h, cy + w);  // ▷ tip at line from left
    outlineTri(page, cx + gap, cy, cx + gap + h, cy - w, cx + gap + h, cy + w);  // ◁ tip at line from right
  } else {
    outlineTri(page, cx, cy + gap, cx - w, cy + gap + h, cx + w, cy + gap + h);  // ▽ tip at line from above
    outlineTri(page, cx, cy - gap, cx - w, cy - gap - h, cx + w, cy - gap - h);  // △ tip at line from below
  }
}

const DATE = new Date().toISOString().slice(0, 10);

for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    // tile content window in the GLOBAL pattern frame (rows numbered from the top)
    const gx0 = c * stepX;
    const gy0 = Hpt - r * stepY - usableH;
    const xmin = gx0, xmax = gx0 + usableW, ymin = gy0, ymax = gy0 + usableH;
    const toS = (gx, gy) => [SAFE + (gx - gx0), SAFE + (gy - gy0)];   // global -> sheet

    // 1) pattern geometry, clipped per-segment to this tile's window
    for (const path of pat.paths) {
      const st = STYLE[path.kind] || STYLE.seam;
      for (let i = 0; i < path.points.length - 1; i++) {
        const [ax, ay] = path.points[i], [bx, by] = path.points[i + 1];
        const seg = clipSeg(ax * MM, ay * MM, bx * MM, by * MM, xmin, xmax, ymin, ymax);
        if (!seg) continue;
        const [s0x, s0y] = toS(seg[0], seg[1]);
        const [s1x, s1y] = toS(seg[2], seg[3]);
        drawSeg(page, s0x, s0y, s1x, s1y, st);
      }
    }

    // 2) alignment lines at overlap-band CENTERS — coincide on the neighbour by
    //    construction. Right neighbour: band center global x = (c+1)*stepX + OVERLAP/2.
    const vline = (gx) => {
      const sx = SAFE + (gx - gx0);
      page.drawLine({ start: { x: sx, y: SAFE }, end: { x: sx, y: PAGE_H - SAFE },
        thickness: 0.7, color: GREY, dashArray: [4, 4] });
      regMark(page, sx, SAFE + 0.22 * usableH, "v");   // two marks along the line
      regMark(page, sx, SAFE + 0.78 * usableH, "v");   // (clear of the centre content)
      ink(sx, SAFE); ink(sx, PAGE_H - SAFE);
    };
    const hline = (gy) => {
      const sy = SAFE + (gy - gy0);
      page.drawLine({ start: { x: SAFE, y: sy }, end: { x: PAGE_W - SAFE, y: sy },
        thickness: 0.7, color: GREY, dashArray: [4, 4] });
      regMark(page, SAFE + 0.22 * usableW, sy, "h");
      regMark(page, SAFE + 0.78 * usableW, sy, "h");
      ink(SAFE, sy); ink(PAGE_W - SAFE, sy);
    };
    if (c < cols - 1) vline((c + 1) * stepX + OVERLAP / 2, "R");   // right band
    if (c > 0)        vline(c * stepX + OVERLAP / 2, "L");          // left band
    if (r > 0)        hline(Hpt - r * stepY - OVERLAP / 2, "T");    // top band
    if (r < rows - 1) hline(Hpt - (r + 1) * stepY + OVERLAP / 2, "B"); // bottom band

    // 3) big tile id (top-left, inside SAFE; baseline low enough that the 24pt cap
    //    height stays inside the keep-out — see the top-edge self-assertion)
    label(page, tileLabel(r, c), SAFE + 4, PAGE_H - SAFE - 30, 24, fontB);

    // 4) per-sheet 50mm scale check (bottom-right, inside SAFE) — survives onto EVERY tile
    const sq = 50 * MM, sqx = PAGE_W - SAFE - sq - 4, sqy = SAFE + 16;
    page.drawRectangle({ x: sqx, y: sqy, width: sq, height: sq, color: WHITE, opacity: 0.85 });
    page.drawRectangle({ x: sqx, y: sqy, width: sq, height: sq, borderColor: BLACK, borderWidth: 0.8 });
    label(page, "50 mm check", sqx, sqy - 11, 7, font, GREY, false);
    ink(sqx, sqy); ink(sqx + sq, sqy + sq);

    // 5) footer (bottom-left, inside SAFE)
    label(page, `${pat.name}  ·  Tile ${tileLabel(r, c)} of ${rows}x${cols}  ·  page ${r * cols + c + 1}/${rows * cols}  ·  ${DATE}`,
      SAFE + 4, SAFE + 2, 8, font, BLACK);
  }
}

// ── assembly map (final page) ────────────────────────────────────────────────
{
  const page = doc.addPage([PAGE_W, PAGE_H]);
  label(page, "Assembly map", SAFE + 4, PAGE_H - SAFE - 22, 22, fontB, BLACK, false);
  label(page, `${pat.name}  —  ${rows} rows x ${cols} cols = ${rows * cols} sheets.  Finished: ${pat.widthMm} x ${pat.heightMm} mm  (${(pat.widthMm/25.4).toFixed(1)} x ${(pat.heightMm/25.4).toFixed(1)} in).`,
    SAFE + 4, PAGE_H - SAFE - 44, 10, font, BLACK, false);
  const gw = PAGE_W - 2 * SAFE - 20, gh = 0.5 * (PAGE_H - 2 * SAFE);
  const cw = gw / cols, ch = gh / rows;
  const ox = SAFE + 10, oy = PAGE_H - SAFE - 70 - gh;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = ox + c * cw, y = oy + (rows - 1 - r) * ch;   // row A at top
    page.drawRectangle({ x, y, width: cw - 3, height: ch - 3, borderColor: BLACK, borderWidth: 0.8 });
    label(page, tileLabel(r, c), x + cw / 2 - 9, y + ch / 2 - 6, 13, fontB, BLACK, false);
  }
  label(page, "Print at 100% / Actual Size. Overlap each sheet onto its neighbour so the dashed alignment lines + triangle tips coincide, then tape.",
    SAFE + 4, oy - 26, 9, font, BLACK, false);
  label(page, "Legend:  long-dash = CUT      dash-dot = FOLD      faint dashes + triangle tips = ALIGN/OVERLAP",
    SAFE + 4, oy - 42, 9, font, GREY, false);
}

const bytes = await doc.save();
writeFileSync(new URL("tiled.pdf", import.meta.url), bytes);

// ── MANDATORY self-assertions (refuse to ship a bad PDF) ─────────────────────
const check = await PDFDocument.load(bytes);
const fail = [];
const pages = check.getPages();
const contentPages = rows * cols;                  // last page is the assembly map
pages.forEach((p, i) => {
  const { width, height } = p.getSize();
  if (Math.abs(width - 612) > 0.01 || Math.abs(height - 792) > 0.01) fail.push(`page ${i}: size ${width}x${height} != 612x792`);
  if ((p.getRotation().angle || 0) !== 0) fail.push(`page ${i}: rotation ${p.getRotation().angle} != 0`);
  const mb = p.getMediaBox(), cb = p.getCropBox();
  if (mb.x !== 0 || mb.y !== 0) fail.push(`page ${i}: MediaBox origin (${mb.x},${mb.y}) != 0,0`);
  if (Math.abs(cb.x - mb.x) > 0.01 || Math.abs(cb.y - mb.y) > 0.01 || Math.abs(cb.width - mb.width) > 0.01 || Math.abs(cb.height - mb.height) > 0.01)
    fail.push(`page ${i}: CropBox != MediaBox`);
});
if (Math.abs((usableW - stepX) - OVERLAP) > 1e-6) fail.push(`overlap X ${(usableW-stepX).toFixed(2)} != 36`);
if (Math.abs((usableH - stepY) - OVERLAP) > 1e-6) fail.push(`overlap Y ${(usableH-stepY).toFixed(2)} != 36`);
const tol = 0.5;
if (inkMinX < SAFE - tol) fail.push(`ink crosses left keep-out: ${inkMinX.toFixed(2)} < ${SAFE.toFixed(2)}`);
if (inkMinY < SAFE - tol) fail.push(`ink crosses bottom keep-out: ${inkMinY.toFixed(2)} < ${SAFE.toFixed(2)}`);
if (inkMaxX > PAGE_W - SAFE + tol) fail.push(`ink crosses right keep-out: ${inkMaxX.toFixed(2)} > ${(PAGE_W-SAFE).toFixed(2)}`);
if (inkMaxY > PAGE_H - SAFE + tol) fail.push(`ink crosses top keep-out: ${inkMaxY.toFixed(2)} > ${(PAGE_H-SAFE).toFixed(2)}`);

console.log(`pattern: ${pat.name}  ${pat.widthMm}x${pat.heightMm}mm`);
console.log(`grid:    ${rows} rows x ${cols} cols = ${contentPages} sheets (+1 assembly map = ${pages.length} pages)`);
console.log(`window:  ${usableW.toFixed(1)}x${usableH.toFixed(1)}pt  step ${stepX.toFixed(1)}x${stepY.toFixed(1)}pt  overlap ${OVERLAP}pt`);
console.log(`ink box: x[${inkMinX.toFixed(1)},${inkMaxX.toFixed(1)}] y[${inkMinY.toFixed(1)},${inkMaxY.toFixed(1)}]  keep-out [${SAFE.toFixed(1)},${(PAGE_W-SAFE).toFixed(1)}]/[${SAFE.toFixed(1)},${(PAGE_H-SAFE).toFixed(1)}]`);
if (fail.length) { console.error("\nSELF-ASSERTIONS FAILED:\n - " + fail.join("\n - ")); process.exit(1); }
console.log(`\nwrote tiled.pdf (${bytes.length} bytes) — all ${pages.length} pages 612x792, rot 0, CropBox==MediaBox, ink within keep-out. PASS.`);
