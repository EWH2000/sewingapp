/* pattern-pdf.js — in-browser PDF generation (vendored pdf-lib UMD = window.PDFLib).
 *
 * A faithful port of the verified, physically-proven generators in
 * ~/sewingapp/tools/ (make-calibration-pdf.mjs, make-tiled-pdf.mjs): same 1:1
 * geometry, same hollow registration triangles, same per-page MediaBox
 * invariants. The browser builds the PDF; the server only relays the bytes to
 * the printer over IPP (print-scaling=none). Exposes window.PatternPDF.
 */
(function () {
  const { PDFDocument, rgb, StandardFonts, LineCapStyle } = window.PDFLib;

  const IN = 72, MM = 72 / 25.4;
  const PAGE_W = 8.5 * IN, PAGE_H = 11 * IN;
  const SAFE = 13 * MM;                 // hardware-margin keep-out (probed 4.23mm)
  const OVERLAP = 0.5 * IN;
  const BLACK = rgb(0, 0, 0), GREY = rgb(0.55, 0.57, 0.6), WHITE = rgb(1, 1, 1);
  const RED = rgb(0.83, 0.18, 0.18), MUTED = rgb(0.42, 0.44, 0.48);

  const STYLE = {
    cut:  { color: BLACK, thickness: 1.1, dashArray: [11, 4] },     // CUT line (long-dash)
    fold: { color: BLACK, thickness: 0.9, dashArray: [8, 3, 1.2, 3] }, // FOLD (dash-dot)
    seam: { color: GREY,  thickness: 0.5, dashArray: [3, 3] },      // stitch / seam-allowance line
    grain: { color: BLACK, thickness: 0.8, dashArray: undefined },  // grainline arrow (solid)
  };

  // ── calibration page (1:1 proof) ───────────────────────────────────────────
  async function makeCalibrationPdf() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    let top = PAGE_H - SAFE;
    const text = (s, x, y, size, f = font, c = BLACK) => page.drawText(s, { x, y, size, font: f, color: c });

    text("Sewing — 1:1 print calibration", SAFE, top - 14, 16, bold); top -= 30;
    text('PRINT AT 100% / ACTUAL SIZE — NOT "Fit to Page" / "Shrink to fit".', SAFE, top - 11, 11, bold, RED); top -= 16;
    text("Adobe Reader: Page Sizing & Handling -> Actual Size.  Browser: Scale 100%, Margins None.", SAFE, top - 10, 9.5, font, MUTED); top -= 14;
    text("Then measure the marks. Tolerance +/- 1 mm. If anything reads short/long, a scaling", SAFE, top - 10, 9.5, font, MUTED); top -= 12;
    text("setting is on — fix it and reprint before using real patterns.", SAFE, top - 10, 9.5, font, MUTED); top -= 26;

    const sqTop = top, sqIn = IN;
    page.drawRectangle({ x: SAFE, y: sqTop - sqIn, width: sqIn, height: sqIn, borderColor: BLACK, borderWidth: 1 });
    text("1 inch", SAFE + 6, sqTop - sqIn / 2 - 4, 9, bold);
    text("(25.4 mm)", SAFE + 4, sqTop - sqIn / 2 - 16, 8, font, MUTED);
    const sqCm = 5 * 10 * MM, cmX = SAFE + sqIn + 28 * MM;
    page.drawRectangle({ x: cmX, y: sqTop - sqCm, width: sqCm, height: sqCm, borderColor: BLACK, borderWidth: 1 });
    text("5 cm", cmX + 6, sqTop - sqCm / 2 - 4, 9, bold);
    top = sqTop - sqCm - 34;

    function ruler(x, y, lengthPt, majorPt, minorPt, label, unit) {
      page.drawLine({ start: { x, y }, end: { x: x + lengthPt, y }, thickness: 1, color: BLACK, lineCap: LineCapStyle.Butt });
      for (let p = 0; p <= lengthPt + 0.01; p += minorPt)
        page.drawLine({ start: { x: x + p, y }, end: { x: x + p, y: y - 4.5 * MM }, thickness: 0.5, color: MUTED });
      let n = 0;
      for (let p = 0; p <= lengthPt + 0.01; p += majorPt, n++) {
        page.drawLine({ start: { x: x + p, y }, end: { x: x + p, y: y - 9 * MM }, thickness: 1, color: BLACK });
        text(String(n), x + p - 2.5, y - 9 * MM - 10, 8);
      }
      text(label, x, y + 6, 9.5, bold);
      text(unit, x + lengthPt - 26, y + 6, 8, font, MUTED);
    }
    ruler(SAFE, top, 6 * IN, IN, IN / 2, "6-inch ruler  (end-to-end = 6.000 in)", "inches"); top -= 30 * MM;
    ruler(SAFE, top, 15 * 10 * MM, 10 * MM, 5 * MM, "15-cm ruler  (end-to-end = 15.0 cm)", "cm"); top -= 30 * MM;

    text("Phase-1 calibration  ·  US Letter 612x792 pt  ·  72 pt/in", SAFE, SAFE - 2, 7.5, font, MUTED);
    return doc.save();
  }

  // ── pattern document -> tiled US-Letter PDF (1:1) ──────────────────────────
  function clipSeg(x0, y0, x1, y1, xmin, xmax, ymin, ymax) {
    let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
    const p = [-dx, dx, -dy, dy], q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; }
      else { const t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
        else { if (t < t0) return null; if (t < t1) t1 = t; } }
    }
    return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
  }

  async function makeTiledPdf(pattern) {
    const usableW = PAGE_W - 2 * SAFE, usableH = PAGE_H - 2 * SAFE;
    const stepX = usableW - OVERLAP, stepY = usableH - OVERLAP;
    const Wpt = pattern.widthMm * MM, Hpt = pattern.heightMm * MM;
    const cols = Math.max(1, Math.ceil((Wpt - OVERLAP) / stepX));
    const rows = Math.max(1, Math.ceil((Hpt - OVERLAP) / stepY));

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontB = await doc.embedFont(StandardFonts.HelveticaBold);
    let inkMinX = 1e9, inkMinY = 1e9, inkMaxX = -1e9, inkMaxY = -1e9;
    const ink = (x, y) => { inkMinX = Math.min(inkMinX, x); inkMinY = Math.min(inkMinY, y); inkMaxX = Math.max(inkMaxX, x); inkMaxY = Math.max(inkMaxY, y); };
    const tileLabel = (r, c) => String.fromCharCode(65 + r) + (c + 1);
    const today = new Date().toISOString().slice(0, 10);

    function label(page, s, x, y, size, f = font, color = BLACK, halo = true) {
      if (halo) { const w = f.widthOfTextAtSize(s, size); page.drawRectangle({ x: x - 2, y: y - 2, width: w + 4, height: size + 2, color: WHITE, opacity: 0.85 }); }
      page.drawText(s, { x, y, size, font: f, color }); ink(x, y); ink(x + f.widthOfTextAtSize(s, size), y + size);
    }
    function outlineTri(page, x0, y0, x1, y1, x2, y2) {
      const t = 1.1;
      page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: t, color: BLACK });
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: BLACK });
      page.drawLine({ start: { x: x2, y: y2 }, end: { x: x0, y: y0 }, thickness: t, color: BLACK });
      ink(Math.min(x0, x1, x2), Math.min(y0, y1, y2)); ink(Math.max(x0, x1, x2), Math.max(y0, y1, y2));
    }
    function regMark(page, cx, cy, axis, h = 10, w = 7, gap = 1.8) {
      if (axis === "v") {
        outlineTri(page, cx - gap, cy, cx - gap - h, cy - w, cx - gap - h, cy + w);
        outlineTri(page, cx + gap, cy, cx + gap + h, cy - w, cx + gap + h, cy + w);
      } else {
        outlineTri(page, cx, cy + gap, cx - w, cy + gap + h, cx + w, cy + gap + h);
        outlineTri(page, cx, cy - gap, cx - w, cy - gap - h, cx + w, cy - gap - h);
      }
    }

    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const page = doc.addPage([PAGE_W, PAGE_H]);
      const gx0 = c * stepX, gy0 = Hpt - r * stepY - usableH;
      const xmin = gx0, xmax = gx0 + usableW, ymin = gy0, ymax = gy0 + usableH;
      const toS = (gx, gy) => [SAFE + (gx - gx0), SAFE + (gy - gy0)];
      for (const path of pattern.paths) {
        const st = STYLE[path.kind] || STYLE.seam;
        for (let i = 0; i < path.points.length - 1; i++) {
          const a = path.points[i], b = path.points[i + 1];
          const seg = clipSeg(a[0] * MM, a[1] * MM, b[0] * MM, b[1] * MM, xmin, xmax, ymin, ymax);
          if (!seg) continue;
          const s0 = toS(seg[0], seg[1]), s1 = toS(seg[2], seg[3]);
          page.drawLine({ start: { x: s0[0], y: s0[1] }, end: { x: s1[0], y: s1[1] }, thickness: st.thickness, color: st.color, dashArray: st.dashArray });
          ink(s0[0], s0[1]); ink(s1[0], s1[1]);
        }
      }
      // piece labels — drawn on the tile whose window contains the anchor (so each
      // appears once). Informational, so NOT counted toward the keep-out assertion.
      for (const lab of (pattern.labels || [])) {
        const gx = lab.xMm * MM, gy = lab.yMm * MM;
        if (gx < xmin || gx > xmax || gy < ymin || gy > ymax) continue;
        const [sx, sy] = toS(gx, gy);
        const lines = lab.lines || [lab.text || ""];
        const size = lab.size || 9, lh = size + 3;
        lines.forEach((ln, k) => {
          const w = font.widthOfTextAtSize(ln, size);
          const lx = sx - w / 2, ly = sy + (lines.length - 1) * lh / 2 - k * lh;
          page.drawRectangle({ x: lx - 2, y: ly - 2, width: w + 4, height: size + 2, color: WHITE, opacity: 0.82 });
          page.drawText(ln, { x: lx, y: ly, size, font, color: BLACK });
        });
      }
      const vline = (gx) => { const sx = SAFE + (gx - gx0);
        page.drawLine({ start: { x: sx, y: SAFE }, end: { x: sx, y: PAGE_H - SAFE }, thickness: 0.7, color: GREY, dashArray: [4, 4] });
        regMark(page, sx, SAFE + 0.22 * usableH, "v"); regMark(page, sx, SAFE + 0.78 * usableH, "v"); ink(sx, SAFE); ink(sx, PAGE_H - SAFE); };
      const hline = (gy) => { const sy = SAFE + (gy - gy0);
        page.drawLine({ start: { x: SAFE, y: sy }, end: { x: PAGE_W - SAFE, y: sy }, thickness: 0.7, color: GREY, dashArray: [4, 4] });
        regMark(page, SAFE + 0.22 * usableW, sy, "h"); regMark(page, SAFE + 0.78 * usableW, sy, "h"); ink(SAFE, sy); ink(PAGE_W - SAFE, sy); };
      if (c < cols - 1) vline((c + 1) * stepX + OVERLAP / 2);
      if (c > 0) vline(c * stepX + OVERLAP / 2);
      if (r > 0) hline(Hpt - r * stepY - OVERLAP / 2);
      if (r < rows - 1) hline(Hpt - (r + 1) * stepY + OVERLAP / 2);

      label(page, tileLabel(r, c), SAFE + 4, PAGE_H - SAFE - 30, 24, fontB);
      const sq = 50 * MM, sqx = PAGE_W - SAFE - sq - 4, sqy = SAFE + 16;
      page.drawRectangle({ x: sqx, y: sqy, width: sq, height: sq, color: WHITE, opacity: 0.85 });
      page.drawRectangle({ x: sqx, y: sqy, width: sq, height: sq, borderColor: BLACK, borderWidth: 0.8 });
      label(page, "50 mm check", sqx, sqy - 11, 7, font, GREY, false); ink(sqx, sqy); ink(sqx + sq, sqy + sq);
      label(page, `${pattern.name}  ·  Tile ${tileLabel(r, c)} of ${rows}x${cols}  ·  page ${r * cols + c + 1}/${rows * cols}  ·  ${today}`, SAFE + 4, SAFE + 2, 8, font, BLACK);
    }

    // assembly map
    {
      const page = doc.addPage([PAGE_W, PAGE_H]);
      label(page, "Assembly map", SAFE + 4, PAGE_H - SAFE - 22, 22, fontB, BLACK, false);
      label(page, `${pattern.name}  —  ${rows} rows x ${cols} cols = ${rows * cols} sheets.  Finished: ${pattern.widthMm} x ${pattern.heightMm} mm  (${(pattern.widthMm / 25.4).toFixed(1)} x ${(pattern.heightMm / 25.4).toFixed(1)} in).`, SAFE + 4, PAGE_H - SAFE - 44, 10, font, BLACK, false);
      const gw = PAGE_W - 2 * SAFE - 20, gh = 0.5 * (PAGE_H - 2 * SAFE), cw = gw / cols, ch = gh / rows;
      const ox = SAFE + 10, oy = PAGE_H - SAFE - 70 - gh;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = ox + c * cw, y = oy + (rows - 1 - r) * ch;
        page.drawRectangle({ x, y, width: cw - 3, height: ch - 3, borderColor: BLACK, borderWidth: 0.8 });
        label(page, tileLabel(r, c), x + cw / 2 - 9, y + ch / 2 - 6, 13, fontB, BLACK, false);
      }
      label(page, "Print at 100% / Actual Size. Overlap each sheet so the dashed lines + triangle tips coincide, then tape.", SAFE + 4, oy - 26, 9, font, BLACK, false);
      label(page, "Legend:  long-dash = CUT      dash-dot = FOLD      faint dashes + triangle tips = ALIGN/OVERLAP", SAFE + 4, oy - 42, 9, font, GREY, false);
    }

    // invariant: refuse to hand back a PDF whose ink left the keep-out
    const tol = 0.5;
    if (inkMinX < SAFE - tol || inkMinY < SAFE - tol || inkMaxX > PAGE_W - SAFE + tol || inkMaxY > PAGE_H - SAFE + tol)
      throw new Error("internal: pattern geometry exceeded the printable keep-out");
    const bytes = await doc.save();
    return { bytes, rows, cols, sheets: rows * cols };
  }

  // ── simple pattern documents (the templates grow from here) ────────────────
  const rectPts = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

  function rectanglePattern(name, wMm, hMm) {
    return { name: name || `Rectangle ${wMm}x${hMm}`, kind: "rectangle", widthMm: wMm, heightMm: hMm,
             paths: [{ kind: "cut", points: rectPts(0, 0, wMm, hMm) }] };
  }

  // Boxy tote: a rectangular-prism bag (open top) from flat panels + straps.
  // Pieces are defined at FINISHED size; the CUT line adds seam allowance all round,
  // and a dashed stitch line marks the finished edge. Pieces are shelf-packed into
  // one layout that the tiler splits across Letter sheets. p = {widthMm,heightMm,
  // depthMm, seamMm, strapLenMm, strapWidthMm}.
  function boxyTotePattern(name, p) {
    const SA = Math.max(0, Math.round(p.seamMm ?? 10));
    const W = p.widthMm, H = p.heightMm, D = p.depthMm;
    const strapL = Math.round(p.strapLenMm ?? 600), strapW = Math.round(p.strapWidthMm ?? 25);
    const gap = 12;                                   // mm between pieces in the layout
    const defs = [
      { label: "Front / Back", count: 2, fw: W, fh: H },
      { label: "Side",         count: 2, fw: D, fh: H },
      { label: "Base",         count: 1, fw: W, fh: D },
      { label: "Strap",        count: 2, fw: strapL, fh: strapW },
    ].map(d => ({ ...d, cw: d.fw + 2 * SA, ch: d.fh + 2 * SA }));

    // shelf (next-fit) packing into a bounding box; cap width to the widest piece
    // so a long strap gets its own shelf rather than ballooning every row.
    const capW = Math.max(...defs.map(d => d.cw)) + 2 * gap;
    let x = gap, yTop = gap, shelfH = 0, boundW = 0;
    const placed = [];
    for (const d of defs) {
      if (x + d.cw + gap > capW && x > gap) { yTop += shelfH + gap; x = gap; shelfH = 0; }
      placed.push({ ...d, x, yTop });
      x += d.cw + gap; shelfH = Math.max(shelfH, d.ch); boundW = Math.max(boundW, x);
    }
    const boundH = yTop + shelfH + gap;

    const paths = [], labels = [];
    for (const pc of placed) {
      const gx0 = pc.x, gy1 = boundH - pc.yTop, gy0 = gy1 - pc.ch, gx1 = gx0 + pc.cw;
      const cx = (gx0 + gx1) / 2, cy = (gy0 + gy1) / 2;
      paths.push({ kind: "cut", points: rectPts(gx0, gy0, gx1, gy1) });                 // cut line
      if (SA > 0) paths.push({ kind: "seam", points: rectPts(gx0 + SA, gy0 + SA, gx1 - SA, gy1 - SA) });
      // grainline arrow (vertical, ~55% of the piece, double-headed)
      const gl = 0.55 * (gy1 - gy0), a = cy - gl / 2, b = cy + gl / 2;
      paths.push({ kind: "grain", points: [[cx, a], [cx, b]] });
      paths.push({ kind: "grain", points: [[cx - 4, b - 6], [cx, b], [cx + 4, b - 6]] });
      paths.push({ kind: "grain", points: [[cx - 4, a + 6], [cx, a], [cx + 4, a + 6]] });
      labels.push({ xMm: cx, yMm: cy, size: 10, lines: [
        `${pc.label} — cut ${pc.count}`,
        `${pc.fw} x ${pc.fh} mm finished`,
        SA > 0 ? `+ ${SA} mm seam allowance` : "no seam allowance",
      ] });
    }
    return { name: name || "Boxy tote", kind: "box",
             widthMm: Math.ceil(boundW), heightMm: Math.ceil(boundH),
             paths, labels, params: { widthMm: W, heightMm: H, depthMm: D, seamMm: SA, strapLenMm: strapL, strapWidthMm: strapW } };
  }

  window.PatternPDF = { makeCalibrationPdf, makeTiledPdf, rectanglePattern, boxyTotePattern };
})();
