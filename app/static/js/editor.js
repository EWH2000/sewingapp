/* editor.js — the freeform pattern editor (SVG canvas + interaction).
 *
 * A freeform document is a list of PIECES (front, back, base, a pocket, …) laid
 * out on a shared BOARD. The canvas shows every piece at once (the whole bag);
 * the selected piece is editable in place, the others are dimmed + tappable. Tap
 * a piece to select + zoom to it; "Show all" zooms back out. Drag a piece to
 * arrange it — what you see is what prints. Build via PatternGeom.freeformToDoc
 * and print/download through the proven PatternPDF.makeTiledPdf — touching
 * neither the tiler nor the server print path.
 *
 * Coordinate frames: WORLD = board mm, bottom-left origin, y-up. A piece's node
 * is LOCAL to the piece; its BOARD coord = local + piece.layout. SCREEN = SVG px,
 * top-left, y-down — the camera {k,tx,ty} + y-flip live in PatternGeom.
 * Geometry draws in #layer-geo (matrix(k,0,0,-k,tx,ty), authored in board mm);
 * finger-sized handles + labels in #layer-ui (screen px, identity).
 */
(function () {
  "use strict";
  if (typeof document === "undefined") return;

  const G = window.PatternGeom, PDF = window.PatternPDF;
  const BASE = window.SEWING_BASE || "";
  const api = (p) => BASE + p;
  const $ = (s, r = document) => r.querySelector(s);

  // editor palette (fixed — the canvas is "paper", light regardless of theme)
  const INK = "#1b1d21", GRID_MINOR = "#ece9e2", GRID_MAJOR = "#dcd7cd";
  const ACCENT = "#e0653a", SEL = "#1f9d6b", LABELC = "#6b7079", PAPER = "#fdfdfb";
  // DIM: the unselected pieces. Kept a clear medium slate (not the old pale
  // #b7b3aa) so low-vision eyes can still read every outline; the active piece
  // stays dominant via the orange fill + handles + full-ink stroke.
  const SEAMC = "#8a8f98", DIM = "#5f6470", DIMFILL = "rgba(95,100,112,0.07)";
  const WARN = "#d4351c";   // overlapping pieces — a clear red, readable for low vision
  const FILL = "rgba(224,101,58,0.06)";
  const HIT_VERTEX = 22, HIT_EDGE = 14, K_MIN = 0.05, K_MAX = 40, MOVE_TOL = 4;

  let svg, geoG, gridG, pathsG, edgesG, handlesG, nameInput, readoutEl;
  let rafPending = false;
  let overlapSet = new Set();   // piece indices that overlap another piece on the board

  const state = {
    id: null, name: "", kind: "freeform",
    pieces: [], active: 0,                 // each {id,name,count,seamMm,cornerRadius,closed,nodes,notches,placements,layout}
    snapOn: true, notchMode: false, sewMode: false, curveMode: false, dartMode: false, unit: "in", gridMm: 5,
    seams: [],                            // schema-3 seam graph: {id, a:{piece,edge}, b:{piece,edge}, foldAngle, anchors}
    body: null,                           // schema-3 doc-level wearer measurements {heightMm,bustMm,waistMm,hipMm}
    sewPending: null,                     // {piece:<id>, edge} — the first edge tapped, awaiting its pair
    cam: { k: 1, tx: 0, ty: 0 },
    selection: { type: "none", index: -1 },   // vertex | edge | placement | seam | none
    history: [], hindex: -1,
  };
  const SEW = "#6b57c9";   // seam connectors / sew-mode affordances (a calm violet, distinct on paper)
  const CURVEC = "#2f7de0";   // curve control dots (a clear blue, distinct from the orange corners)
  const DARTC = "#c0398a";    // dart apex handle (a magenta, distinct from curves + corners)
  const SAC = "#0e9aa7";      // a corner with a custom (variable) seam allowance (teal)
  const ZERO = { x: 0, y: 0 };
  const activePiece = () => state.pieces[state.active] || null;
  const layoutOf = (p) => (p && p.layout) ? p.layout : ZERO;
  const activeLayout = () => layoutOf(activePiece());
  const nodes = () => (activePiece() ? activePiece().nodes : []);
  const canEdit = () => !!activePiece() && nodes().length > 0;
  const aB = (n) => { const L = activeLayout(); return { x: n.x + L.x, y: n.y + L.y }; };   // active local → board

  const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ── small UI helpers (mirrors app.js — those are private to its IIFE) ───────
  function setStatus(msg, kind = "info") {
    const bar = $("#statusbar"); if (!bar) return;
    bar.textContent = msg; bar.className = "statusbar show " + kind; bar.hidden = false;
  }
  function clearStatus(after = 0) {
    const bar = $("#statusbar"); if (!bar) return;
    if (after) setTimeout(() => { bar.className = "statusbar"; }, after);
    else bar.className = "statusbar";
  }
  const pdfBlob = (bytes) => new Blob([bytes], { type: "application/pdf" });
  function confirmSheet(message, okLabel = "Print") {
    return new Promise((resolve) => {
      const trigger = document.activeElement;
      const wrap = document.createElement("div");
      wrap.className = "sheet-backdrop";
      wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><p class="sheet__msg"></p>'
        + '<div class="btnrow"><button class="btn btn--ghost" data-no>Cancel</button>'
        + '<button class="btn btn--primary" data-yes></button></div></div>';
      $(".sheet__msg", wrap).textContent = message;
      $("[data-yes]", wrap).textContent = okLabel;
      const onKey = (e) => { if (e.key === "Escape") done(false); };
      const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); if (trigger && trigger.focus) trigger.focus(); resolve(v); };
      document.addEventListener("keydown", onKey);
      $("[data-no]", wrap).addEventListener("click", () => done(false));
      $("[data-yes]", wrap).addEventListener("click", () => done(true));
      wrap.addEventListener("click", (e) => { if (e.target === wrap) done(false); });
      document.body.appendChild(wrap); $("[data-yes]", wrap).focus();
    });
  }
  function download(bytes, filename) {
    const url = URL.createObjectURL(pdfBlob(bytes));
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function downloadText(text, filename, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  async function printBytes(bytes, kind, { sheets, name } = {}) {
    const what = `${name || "this pattern"}${sheets ? " — " + sheets + " sheet" + (sheets > 1 ? "s" : "") : ""}`;
    if (!(await confirmSheet(`Print ${what}?`))) return;
    setStatus("Sending to the printer…", "info");
    const fd = new FormData();
    fd.append("pdf", pdfBlob(bytes), "pattern.pdf");
    fd.append("kind", kind); fd.append("confirm", "true"); fd.append("job_name", name || kind);
    let res; try { res = await fetch(api("/print"), { method: "POST", body: fd }); }
    catch { setStatus("Couldn't reach the app.", "bad"); return; }
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) {
      const d = data.detail || {};
      if (d.code === "needs_calibration") setStatus("Print the test page first (Home), then confirm it measured right.", "warn");
      else setStatus(d.message || "The printer couldn't take the job.", "bad");
      return;
    }
    setStatus("Printing… go collect your sheets.", "good");
    if (data.job_id) pollJob(data.job_id);
  }
  async function pollJob(jobId) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      let d; try { d = await (await fetch(api("/print/status/" + jobId))).json(); }
      catch { setStatus("Stopped checking the printer — the job may still be printing.", "warn"); return; }
      if (d.needs_attention) { setStatus("The printer stopped — check for a jam, open cover, or empty tray.", "warn"); return; }
      if (d.done) { setStatus("Print finished.", "good"); clearStatus(4000); return; }
    }
  }

  // ── units / formatting ──────────────────────────────────────────────────────
  // Display/input units only — the document is always real millimetres (print-safe).
  // inches (default) + cm; mm is no longer offered (legacy fallthrough kept harmless).
  const toMm = (v) => (state.unit === "in" ? v * 25.4 : state.unit === "cm" ? v * 10 : v);
  const unitLabel = () => (state.unit === "in" ? "inches" : state.unit === "cm" ? "centimetres" : "mm");
  const unitShort = () => (state.unit === "in" ? "in" : state.unit === "cm" ? "cm" : "mm");
  function fmtVal(mm) {
    if (state.unit === "in") return (mm / 25.4).toFixed(2);
    if (state.unit === "cm") return (Math.round(mm) / 10).toFixed(1);
    const r = Math.round(mm * 10) / 10; return String(Number.isInteger(r) ? r : r.toFixed(1));
  }
  const fmtLen = (mm) => fmtVal(mm) + (state.unit === "in" ? '"' : state.unit === "cm" ? " cm" : " mm");

  // ── camera + fit ────────────────────────────────────────────────────────────
  const W2S = (n) => G.worldToScreen(n.x, n.y, state.cam);
  const S2W = (sx, sy) => G.screenToWorld(sx, sy, state.cam);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function pieceBoardNodes(p) { const L = layoutOf(p); return p.nodes.map((n) => ({ x: n.x + L.x, y: n.y + L.y })); }
  function boardPointsAll() {
    const pts = [];
    for (const p of state.pieces) { const L = layoutOf(p); for (const n of p.nodes) pts.push([n.x + L.x, n.y + L.y]); }
    return pts.length ? pts : [[0, 0], [300, 400]];
  }
  function fitPoints(pts) {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const bb = G.bbox(pts), pad = 48;
    const k = clamp(Math.min((r.width - 2 * pad) / Math.max(bb.w, 1), (r.height - 2 * pad) / Math.max(bb.h, 1)), K_MIN, K_MAX);
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    state.cam = { k, tx: r.width / 2 - k * cx, ty: r.height / 2 + k * cy };
  }
  function fitAll() { fitPoints(boardPointsAll()); }
  function fitPiece(i) { const p = state.pieces[i]; fitPoints(p ? pieceBoardNodes(p).map((n) => [n.x, n.y]) : boardPointsAll()); }
  function ensureInitialFit(tries) {
    const r = svg.getBoundingClientRect();
    if ((!r.width || !r.height) && tries > 0) { requestAnimationFrame(() => ensureInitialFit(tries - 1)); return; }
    fitAll(); render();
  }
  function boardBBox() {
    const pts = boardPointsAll();
    return G.bbox(pts);
  }
  function placeToRight(piece) {
    const lb = G.bbox(piece.nodes.map((n) => [n.x, n.y]));
    const bb = state.pieces.length ? boardBBox() : { maxX: 0, minY: 0 };
    piece.layout = { x: G.round2(bb.maxX + 20 - lb.minX), y: G.round2((bb.minY || 0) - lb.minY) };
  }

  // ── overlap detection (axis-aligned board bboxes; cheap n² over a few pieces) ─
  function computeOverlaps() {
    const set = new Set(), EPS = 0.5;   // ignore merely-touching edges
    const boxes = state.pieces.map((p) => G.bbox(pieceBoardNodes(p).map((n) => [n.x, n.y])));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        if (ox > EPS && oy > EPS) { set.add(i); set.add(j); }
      }
    overlapSet = set;
    return set;
  }
  function warnIfOverlap() {
    if (computeOverlaps().size) { setStatus("Heads up — pieces overlap; they'll print on top of each other.", "warn"); clearStatus(4500); }
  }

  // ── render ──────────────────────────────────────────────────────────────────
  function scheduleRender() {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }
  function render() { applyCamera(); drawGrid(); computeOverlaps(); drawPaths(); drawOverlay(); renderPieceList(); renderSeamList(); renderMeasureCard(); updateNumericPanel(); updateButtons(); }
  function applyCamera() { geoG.setAttribute("transform", G.cameraMatrix(state.cam)); }

  function drawGrid() {
    const r = svg.getBoundingClientRect();
    const c0 = S2W(0, 0), c1 = S2W(r.width, r.height);
    const wx0 = Math.min(c0.x, c1.x), wx1 = Math.max(c0.x, c1.x);
    const wy0 = Math.min(c0.y, c1.y), wy1 = Math.max(c0.y, c1.y);
    const minor = state.gridMm, major = state.gridMm * 5;
    let s = "";
    const drawSet = (step, color, width) => {
      if (step * state.cam.k < 6) return;
      let cnt = 0;
      for (let x = Math.ceil(wx0 / step) * step; x <= wx1 && cnt < 600; x += step, cnt++)
        s += `<line x1="${x}" y1="${wy0}" x2="${x}" y2="${wy1}" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`;
      for (let y = Math.ceil(wy0 / step) * step; y <= wy1 && cnt < 1200; y += step, cnt++)
        s += `<line x1="${wx0}" y1="${y}" x2="${wx1}" y2="${y}" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`;
    };
    drawSet(minor, GRID_MINOR, 1);
    drawSet(major, GRID_MAJOR, 1.4);
    s += `<line x1="${wx0}" y1="0" x2="${wx1}" y2="0" stroke="${GRID_MAJOR}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
    s += `<line x1="0" y1="${wy0}" x2="0" y2="${wy1}" stroke="${GRID_MAJOR}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
    gridG.innerHTML = s;
  }

  // per-piece flattened geometry cache (rounded cut + inset seam), keyed by the
  // piece object → its signature, so pan/zoom never re-runs Maker.js.
  const geomCacheMap = new Map();
  function pieceGeomCached(p) {
    // include edges (curves) + darts so adding/editing one busts the stale geometry cache and re-renders.
    // (per-node saMm is already covered — it lives inside p.nodes.)
    const key = JSON.stringify({ e: p.edges || null, d: p.darts || null, n: p.nodes, r: p.cornerRadius || 0, s: p.seamMm || 0, c: p.closed });
    const c = geomCacheMap.get(p);
    if (c && c.key === key) return c;
    const g = G.pieceGeom(p);
    const entry = { key, cut: g.cut || [], seam: g.seam || null };
    geomCacheMap.set(p, entry);
    return entry;
  }
  const polyD = (pts) => pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ") + " Z";
  function drawPaths() {
    let s = "";
    for (let pi = 0; pi < state.pieces.length; pi++) {
      const p = state.pieces[pi], L = layoutOf(p), act = pi === state.active;
      const g = pieceGeomCached(p);
      const off = (pts) => pts.map((pt) => [pt[0] + L.x, pt[1] + L.y]);
      const op = act ? 1 : 0.85, over = overlapSet.has(pi);
      if (g.seam && g.seam.length)
        s += `<path d="${polyD(off(g.seam))}" fill="none" stroke="${SEAMC}" stroke-width="1" stroke-dasharray="5 3" opacity="${op}" vector-effect="non-scaling-stroke"/>`;
      if (g.cut && g.cut.length)
        s += `<path d="${polyD(off(g.cut))}" fill="${act ? FILL : DIMFILL}" stroke="${over ? WARN : (act ? INK : DIM)}" stroke-width="${over ? 2.2 : (act ? 2 : 1.7)}" opacity="${op}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      (p.placements || []).forEach((pl, idx) => {
        const sel = act && state.selection.type === "placement" && state.selection.index === idx;
        const pts = `${pl.x + L.x},${pl.y + L.y} ${pl.x + pl.w + L.x},${pl.y + L.y} ${pl.x + pl.w + L.x},${pl.y + pl.h + L.y} ${pl.x + L.x},${pl.y + pl.h + L.y}`;
        s += `<polygon points="${pts}" fill="none" stroke="${sel ? SEL : SEAMC}" stroke-width="${sel ? 2 : 1.3}" opacity="${op}" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`;
      });
      for (const nt of (p.notches || [])) {
        for (const m of G.notchTicks(p.nodes, nt))   // upgraded {edge,t,type} → 1 (single) or 2 (double) ticks; legacy {x,y} → 1
          s += `<line x1="${m[0][0] + L.x}" y1="${m[0][1] + L.y}" x2="${m[1][0] + L.x}" y2="${m[1][1] + L.y}" stroke="${act ? INK : DIM}" stroke-width="1.6" opacity="${op}" vector-effect="non-scaling-stroke"/>`;
      }
    }
    pathsG.innerHTML = s;
  }

  function labelTag(x, y, text, color) {
    const w = text.length * 6.4 + 8;
    return `<rect x="${x - w / 2}" y="${y - 11}" width="${w}" height="15" rx="3" fill="${PAPER}" opacity="0.86"/>`
      + `<text x="${x}" y="${y}" text-anchor="middle" font-size="11" font-family="'Hanken Grotesk',system-ui,sans-serif" font-weight="600" fill="${color}">${escapeHtml(text)}</text>`;
  }
  function drawOverlay() {
    let eSvg = "", hSvg = "";
    // name labels on the INACTIVE pieces (the overview tells you what each is)
    for (let pi = 0; pi < state.pieces.length; pi++) {
      if (pi === state.active) continue;
      const p = state.pieces[pi], L = layoutOf(p), bb = G.bbox(p.nodes.map((n) => [n.x, n.y]));
      const c = W2S({ x: L.x + bb.minX + bb.w / 2, y: L.y + bb.minY + bb.h / 2 });
      eSvg += labelTag(c.sx, c.sy + 4, p.name + (p.count > 1 ? " ×" + p.count : ""), LABELC);
    }
    const ap = activePiece();
    if (ap) {
      const ns = ap.nodes, n = ns.length;
      for (let i = 0; i < n; i++) {
        const a = ns[i], b = ns[(i + 1) % n];
        const as = W2S(aB(a)), bs = W2S(aB(b));
        const isSel = state.selection.type === "edge" && state.selection.index === i;
        if (isSel) eSvg += `<line x1="${as.sx}" y1="${as.sy}" x2="${bs.sx}" y2="${bs.sy}" stroke="${SEL}" stroke-width="3"/>`;
        const mx = (as.sx + bs.sx) / 2, my = (as.sy + bs.sy) / 2;
        eSvg += labelTag(mx, my - 6, fmtLen(G.edgeLength(a, b)), isSel ? SEL : LABELC);
      }
      (ap.placements || []).forEach((pl, i) => {
        const c = W2S(aB({ x: pl.x + pl.w / 2, y: pl.y + pl.h / 2 }));
        const sel = state.selection.type === "placement" && state.selection.index === i;
        eSvg += labelTag(c.sx, c.sy + 4, pl.label || "Pocket", sel ? SEL : SEAMC);
      });
      if (!state.sewMode && !state.curveMode && !state.dartMode) {   // corner handles: editing only — hide in sew/curve/dart modes
        for (let i = 0; i < n; i++) {
          const s = W2S(aB(ns[i]));
          const isSel = state.selection.type === "vertex" && state.selection.index === i;
          if (isSel) hSvg += `<circle cx="${s.sx}" cy="${s.sy}" r="11" fill="none" stroke="${SEL}" stroke-width="2"/>`;
          hSvg += `<circle cx="${s.sx}" cy="${s.sy}" r="6.5" fill="${ns[i].saMm > 0 ? SAC : ACCENT}" stroke="#fff" stroke-width="1.6"/>`;
        }
      }
      // curve control dots — only in curve mode (so they never steal a corner drag elsewhere)
      if (state.curveMode && ap.edges) {
        for (const k of Object.keys(ap.edges)) {
          const i = parseInt(k, 10); if (!(i >= 0 && i < n)) continue;
          const c = ap.edges[k].curve; if (!c || !Array.isArray(c.cp)) continue;
          const a = ns[i], b = ns[(i + 1) % n];
          const isSel = state.selection.type === "curve" && state.selection.index === i;
          const mid = W2S(aB({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
          for (const sl of (c.type === "cubic" ? [0, 2] : [0])) {
            const wl = G.edgeLocalToWorld(a, b, c.cp[sl], c.cp[sl + 1]);
            const dot = W2S(aB({ x: wl[0], y: wl[1] }));
            hSvg += `<line x1="${mid.sx}" y1="${mid.sy}" x2="${dot.sx}" y2="${dot.sy}" stroke="${CURVEC}" stroke-width="1.2" opacity="0.5"/>`;
            if (isSel) hSvg += `<circle cx="${dot.sx}" cy="${dot.sy}" r="12" fill="none" stroke="${SEL}" stroke-width="2"/>`;
            hSvg += `<circle cx="${dot.sx}" cy="${dot.sy}" r="8" fill="${CURVEC}" stroke="#fff" stroke-width="1.6"/>`;
          }
        }
      }
      // dart apex handles — only in dart mode (a dashed centerline base→apex + the draggable tip)
      if (state.dartMode && ap.darts) {
        ap.darts.forEach((d, i) => {
          const apex = dartApexLocal(ap, d); if (!apex) return;
          const base = W2S(aB(apex.base)), tip = W2S(aB(apex));
          const isSel = state.selection.type === "dart" && state.selection.index === i;
          eSvg += `<line x1="${base.sx}" y1="${base.sy}" x2="${tip.sx}" y2="${tip.sy}" stroke="${DARTC}" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.85"/>`;
          if (isSel) hSvg += `<circle cx="${tip.sx}" cy="${tip.sy}" r="12" fill="none" stroke="${SEL}" stroke-width="2"/>`;
          hSvg += `<circle cx="${tip.sx}" cy="${tip.sy}" r="8" fill="${DARTC}" stroke="#fff" stroke-width="1.6"/>`;
        });
      }
    }
    eSvg += seamOverlaySvg();
    edgesG.innerHTML = eSvg;
    handlesG.innerHTML = hSvg;
  }
  // Seam connectors (always shown) + sew-mode affordances (tappable edge-mid dots + the
  // pending first edge). Screen-space, drawn over every piece on the board.
  function seamOverlaySvg() {
    let s = "";
    if (state.sewMode) {
      for (const pc of state.pieces) {
        const L = layoutOf(pc), nn = pc.nodes.length;
        for (let i = 0; i < nn; i++) {
          const a = pc.nodes[i], b = pc.nodes[(i + 1) % nn];
          const m = W2S({ x: (a.x + b.x) / 2 + L.x, y: (a.y + b.y) / 2 + L.y });
          s += `<circle cx="${m.sx}" cy="${m.sy}" r="3.5" fill="${SEW}" opacity="0.45"/>`;
        }
      }
    }
    for (let i = 0; i < state.seams.length; i++) {
      const sm = state.seams[i], ma = edgeMidScreen(sm.a), mb = edgeMidScreen(sm.b);
      if (!ma || !mb) continue;
      const sel = state.selection.type === "seam" && state.selection.index === i;
      if (sel) for (const ref of [sm.a, sm.b]) { const e = edgeEndpointsScreen(ref); if (e) s += `<line x1="${e.a.sx}" y1="${e.a.sy}" x2="${e.b.sx}" y2="${e.b.sy}" stroke="${SEL}" stroke-width="3"/>`; }
      s += `<line x1="${ma.sx}" y1="${ma.sy}" x2="${mb.sx}" y2="${mb.sy}" stroke="${sel ? SEL : SEW}" stroke-width="${sel ? 3 : 2}"${sel ? "" : ' stroke-dasharray="2 3"'} opacity="0.9"/>`;
      for (const m of [ma, mb]) s += `<circle cx="${m.sx}" cy="${m.sy}" r="${sel ? 5 : 4}" fill="${sel ? SEL : SEW}"/>`;
    }
    if (state.sewMode && state.sewPending) {
      const e = edgeEndpointsScreen(state.sewPending);
      if (e) s += `<line x1="${e.a.sx}" y1="${e.a.sy}" x2="${e.b.sx}" y2="${e.b.sy}" stroke="${ACCENT}" stroke-width="4" opacity="0.9"/>`;
    }
    return s;
  }

  // ── pieces panel ─────────────────────────────────────────────────────────────
  function renderPieceList() {
    const list = $("#ed-pieces");
    if (list) {
      list.innerHTML = state.pieces.map((p, i) => {
        const bb = G.bbox(G.nodesToPoints(p.nodes, p.closed));
        return `<button class="piece-row${i === state.active ? " on" : ""}" data-action="ed-select-piece" data-piece="${i}">`
          + `<span class="piece-row__name">${escapeHtml(p.name)}</span>`
          + `<span class="piece-row__meta">${fmtVal(bb.w)}×${fmtVal(bb.h)} ${unitShort()}${p.count > 1 ? " · cut " + p.count : ""}</span>`
          + `</button>`;
      }).join("");
    }
    const ed = $("#ed-piece-edit"); if (!ed) return;
    const ap = activePiece();
    if (!ap) { ed.innerHTML = ""; return; }
    const seamFailed = (ap.seamMm || 0) > 0 && !pieceGeomCached(ap).seam;
    ed.innerHTML =
      `<div class="grid2">`
      + `<label class="fld" style="margin:0"><span>Piece name</span><input type="text" id="ed-piece-name" value="${escapeAttr(ap.name)}"></label>`
      + `<label class="fld" style="margin:0"><span>Cut count</span><input type="number" id="ed-piece-count" min="1" step="1" value="${ap.count}"></label>`
      + `</div>`
      + `<div class="grid2" style="margin-top:8px">`
      + `<label class="fld" style="margin:0"><span>Round corners (${unitShort()})</span><input type="number" id="ed-piece-radius" min="0" step="any" inputmode="decimal" value="${fmtVal(ap.cornerRadius || 0)}"></label>`
      + `<label class="fld" style="margin:0"><span>Seam allowance (${unitShort()})</span><input type="number" id="ed-piece-seam" min="0" step="any" inputmode="decimal" value="${fmtVal(ap.seamMm || 0)}"></label>`
      + `</div>`
      + `<label class="fld" style="margin-top:8px;display:block"><span>Type <span class="muted">(3D preview)</span></span>`
      + `<select id="ed-piece-role">`
      + `<option value="auto"${!ap.role && !(ap.place3d && ap.place3d.role === "sleeve") ? " selected" : ""}>Auto-detect</option>`
      + `<option value="panel"${ap.role === "panel" ? " selected" : ""}>Panel (folds flat)</option>`
      + `<option value="strap"${ap.role === "strap" ? " selected" : ""}>Strap / handle</option>`
      + `<option value="sleeve"${ap.place3d && ap.place3d.role === "sleeve" ? " selected" : ""}>Sleeve (set-in)</option>`
      + `</select></label>`
      + (seamFailed ? `<p class="small" style="color:var(--warn);margin:.2rem 0 0">Seam allowance is too large for this shape — reduce it or widen the piece.</p>` : "")
      + `<button class="btn small btn--block" data-action="ed-add-place" style="margin-top:8px">+ Pocket guide</button>`
      + `<div class="btnrow" style="margin-top:8px">`
      + `<button class="btn small" data-action="ed-dup-piece">Duplicate</button>`
      + `<button class="btn small" data-action="ed-del-piece"${state.pieces.length <= 1 ? " disabled" : ""}>Delete piece</button>`
      + `</div>`;
    const nm = $("#ed-piece-name");
    if (nm) nm.addEventListener("change", () => { ap.name = nm.value.trim() || ap.name; commit(); render(); });
    const ct = $("#ed-piece-count");
    if (ct) ct.addEventListener("change", () => { ap.count = Math.max(1, Math.round(parseFloat(ct.value) || 1)); commit(); render(); });
    const rad = $("#ed-piece-radius");
    if (rad) rad.addEventListener("change", () => { const v = toMm(parseFloat(rad.value)); ap.cornerRadius = isFinite(v) && v > 0 ? G.round2(v) : 0; commit(); render(); });
    const sm = $("#ed-piece-seam");
    if (sm) sm.addEventListener("change", () => { const v = toMm(parseFloat(sm.value)); ap.seamMm = isFinite(v) && v > 0 ? G.round2(v) : 0; commit(); render(); });
    const rl = $("#ed-piece-role");
    if (rl) rl.addEventListener("change", () => {
      if (rl.value === "sleeve") { ap.place3d = Object.assign({}, ap.place3d, { role: "sleeve" }); ap.role = null; }
      else {
        ap.role = rl.value === "strap" ? "strap" : rl.value === "panel" ? "panel" : null;
        if (ap.place3d && ap.place3d.role === "sleeve") ap.place3d = ap.place3d.wrap ? { role: null, wrap: ap.place3d.wrap } : null;
      }
      commit(); render();
    });
  }
  function addPiece() {
    const p = G.rectPiece("Piece " + (state.pieces.length + 1), 150, 200);
    p.id = freshPieceId();
    placeToRight(p);
    state.pieces.push(p); state.active = state.pieces.length - 1; select("none", -1); commit(); fitPiece(state.active); render();
  }
  function duplicatePiece() {
    const ap = activePiece(); if (!ap) return;
    const copy = JSON.parse(JSON.stringify(ap)); copy.name = ap.name + " copy"; copy.id = freshPieceId();
    placeToRight(copy);   // a fresh id → the copy starts unsewn (seams stay on the original)
    state.pieces.splice(state.active + 1, 0, copy); state.active += 1; select("none", -1); commit(); fitPiece(state.active); render();
  }
  function deletePiece() {
    if (state.pieces.length <= 1) { setStatus("Keep at least one piece.", "warn"); clearStatus(3000); return; }
    const removed = state.pieces[state.active];
    state.pieces.splice(state.active, 1);
    if (removed) state.seams = state.seams.filter((s) => s.a.piece !== removed.id && s.b.piece !== removed.id);
    state.active = Math.max(0, state.active - 1); select("none", -1); commit(); fitPiece(state.active); render();
  }
  function selectPiece(i) {
    if (i < 0 || i >= state.pieces.length) return;
    state.active = i; select("none", -1); fitPiece(i); render();
  }
  function autoArrange() { G.packLayouts(state.pieces); commit(); fitAll(); render(); }

  // ── set-in sleeve: draft + wire into the bodice (Stage A) ─────────────────────
  // A bodice "panel" we can hang a sleeve on (a front/back garment piece, not a skirt/band/strap).
  function isBodicePanel(p, re) {
    const r = (p.place3d && p.place3d.role) || "", nm = (p.name || "").toLowerCase();
    if (/skirt|band|strap|sleeve|binding|facing/.test(r) || /skirt|waistband|band|strap|sleeve|binding|facing/.test(nm)) return false;
    return re.test(r) || re.test(nm);
  }
  function addSeamSilently(a, b, opts) {
    opts = opts || {};
    const id = freshId("s", new Set(state.seams.map((s) => s.id)));
    const seam = { id, a: { piece: a.piece, edge: a.edge }, b: { piece: b.piece, edge: b.edge }, foldAngle: null, anchors: opts.anchors || null };
    if (opts.ease) seam.ease = opts.ease;
    state.seams.push(seam);
  }
  function addArmholeNotch(piece, edge, t, type) {
    piece.notches = piece.notches || [];
    if (piece.notches.some((nt) => Number.isInteger(nt.edge) && nt.edge === edge && Math.abs((nt.t || 0) - t) < 0.02)) return;
    piece.notches.push({ edge, t, type });
  }
  // Draft a pair of set-in sleeves from the bodice armholes + wire them in (cap↔armhole eased seams,
  // underarm self-seam, matching balance notches). Sleeves only make sense on a garment, so this
  // turns the doc into one (adds default body measurements if absent — the form lofts on /preview).
  function addSleeve() {
    const front = state.pieces.find((p) => isBodicePanel(p, /front/) && G.bodiceArmholes(p));
    const back = state.pieces.find((p) => isBodicePanel(p, /back/) && G.bodiceArmholes(p));
    if (!front || !back) {
      setStatus("To add a sleeve, the doc needs a bodice Front and Back panel with curved armholes (like the tank bodice).", "warn");
      clearStatus(6000); return;
    }
    const fArm = G.bodiceArmholes(front), bArm = G.bodiceArmholes(back);
    if (!state.body) state.body = Object.assign({}, G.DEFAULT_BODY);
    const used = new Set(state.pieces.map((p) => p.id).filter(Boolean));
    let warned = false;
    for (const side of ["R", "L"]) {
      const fA = fArm[side];
      const bA = G.matchedBackArmhole(front, fA.edge, back, bArm, state.seams) || bArm[side];
      const r = G.draftSleeve({ armholeFrontMm: fA.len, armholeBackMm: bA.len,
        bicepMm: Math.round(0.32 * state.body.bustMm), capEaseFrac: 0.06, side });
      const slv = r.piece;
      slv.id = freshId("slv", used); used.add(slv.id);
      placeToRight(slv); state.pieces.push(slv);
      // front cap (e3) ↔ front armhole; back cap (e2) ↔ back armhole (same arm); underarm self-seam e1↔e4.
      addSeamSilently({ piece: slv.id, edge: 3 }, { piece: front.id, edge: fA.edge }, { ease: 0.06 });
      addSeamSilently({ piece: slv.id, edge: 2 }, { piece: back.id, edge: bA.edge }, { ease: 0.06 });
      addSeamSilently({ piece: slv.id, edge: 1 }, { piece: slv.id, edge: 4 });
      // matching balance notches on the bodice armholes: single = front, double = back.
      addArmholeNotch(front, fA.edge, 0.45, "single");
      addArmholeNotch(back, bA.edge, 0.50, "double");
      if (!r.ok) warned = true;
    }
    state.active = state.pieces.length - 1; select("none", -1); commit(); fitAll(); render();
    if (warned) { setStatus("Sleeves added, but a cap is smaller than its armhole — widen the bicep or lower the armhole.", "warn"); clearStatus(7000); }
    else { setStatus("Added a pair of set-in sleeves. Print at 1:1 and tape-check the cap against the armhole.", "info"); clearStatus(6000); }
  }

  // ── body measurements card (doc-level; lofts the dress form on /preview) ──────
  // state.body is null for bags, or {heightMm,bustMm,waistMm,hipMm} for garments. The document is
  // always mm; we show display units. Writes land immediately (so a quick save/undo sees them) and
  // history commits are debounced so a run of keystrokes is one undo step — NO render() in the
  // debounce (it would innerHTML-replace the input and blur it mid-type; preview.js avoids this too).
  let bodyTimer = null;
  function renderMeasureCard() {
    updateMeasureChip();
    const box = $("#ed-measure-body"); if (!box) return;
    if (!state.body) {
      box.innerHTML = `<div class="empty">Not a garment — bags don't need a wearer. Tap “Garment?” to add measurements for the 3D fit preview.</div>`;
      return;
    }
    const row = (id, label, mm) => `<label class="fld" style="margin:0"><span>${label} (${unitShort()})</span>`
      + `<input type="number" id="${id}" inputmode="decimal" step="any" min="0" value="${fmtVal(mm)}"></label>`;
    box.innerHTML =
      `<div class="grid2">${row("ed-m-height", "Height", state.body.heightMm)}${row("ed-m-bust", "Bust", state.body.bustMm)}</div>`
      + `<div class="grid2" style="margin-top:8px">${row("ed-m-waist", "Waist", state.body.waistMm)}${row("ed-m-hip", "Hip", state.body.hipMm)}</div>`;
    const bind = (id, key) => {
      const el = $("#" + id); if (!el) return;
      el.addEventListener("input", () => {
        const v = toMm(parseFloat(el.value));
        if (!isFinite(v) || v <= 0) return;             // keep the prior value on an empty/transient entry
        if (!state.body) return;
        state.body[key] = G.round2(v);
        clearTimeout(bodyTimer); bodyTimer = setTimeout(() => commit(), 400);
      });
    };
    bind("ed-m-height", "heightMm"); bind("ed-m-bust", "bustMm");
    bind("ed-m-waist", "waistMm"); bind("ed-m-hip", "hipMm");
  }
  function updateMeasureChip() { const c = $("#ed-garment-chip"); if (c) c.classList.toggle("on", !!state.body); }
  function toggleGarment() {
    state.body = state.body ? null : Object.assign({}, G.DEFAULT_BODY);   // shallow copy — never mutate the shared constant
    commit(); render();
  }

  // ── numeric panel ──────────────────────────────────────────────────────────
  function updateNumericPanel() {
    const box = $("#ed-numeric"); if (!box) return;
    const sel = state.selection, ns = nodes();
    if (!canEdit()) { box.innerHTML = `<div class="empty">Add or pick a piece to start drawing.</div>`; return; }
    if (sel.type === "vertex" && ns[sel.index]) {
      const n = ns[sel.index];
      box.innerHTML =
        `<div class="row row--between"><strong>Corner ${sel.index + 1}</strong><span class="small muted">${unitLabel()}</span></div>`
        + `<div class="grid2">`
        + `<label class="fld" style="margin:0"><span>X</span><input type="number" id="ed-x" inputmode="decimal" step="any" value="${fmtVal(n.x)}"></label>`
        + `<label class="fld" style="margin:0"><span>Y</span><input type="number" id="ed-y" inputmode="decimal" step="any" value="${fmtVal(n.y)}"></label>`
        + `</div>`
        + `<label class="fld" style="margin:.4rem 0 0"><span>Round this corner (${unitShort()}) — 0 = use piece default</span>`
        + `<input type="number" id="ed-radius" inputmode="decimal" step="any" min="0" value="${fmtVal(n.radius || 0)}"></label>`
        + `<label class="fld" style="margin:.4rem 0 0"><span>Seam allowance at this corner (${unitShort()}) — 0 = use piece default</span>`
        + `<input type="number" id="ed-sa" inputmode="decimal" step="any" min="0" value="${fmtVal(n.saMm || 0)}"></label>`
        + ((activePiece() && activePiece().edges && Object.keys(activePiece().edges).length)
          ? `<p class="small" style="color:var(--warn);margin:.2rem 0 0">Custom corner allowance is saved but inactive while this piece has curved edges — the uniform seam allowance is used instead.</p>` : "");
      wireNumeric(["#ed-x", "#ed-y", "#ed-radius", "#ed-sa"]);
    } else if (sel.type === "edge") {
      const i = sel.index, n = ns.length, a = ns[i], b = ns[(i + 1) % n], j = (i + 1) % n;
      box.innerHTML =
        `<div class="row row--between"><strong>Edge ${i + 1} → ${j + 1}</strong><span class="small muted">${unitLabel()}</span></div>`
        + `<label class="fld" style="margin:.4rem 0 0"><span>Length (moves corner ${j + 1})</span>`
        + `<input type="number" id="ed-len" inputmode="decimal" step="any" min="0" value="${fmtVal(G.edgeLength(a, b))}"></label>`;
      wireNumeric(["#ed-len"]);
    } else if (sel.type === "placement" && activePiece() && activePiece().placements[sel.index]) {
      const pl = activePiece().placements[sel.index];
      box.innerHTML =
        `<div class="row row--between"><strong>Pocket guide</strong><span class="small muted">${unitLabel()}</span></div>`
        + `<label class="fld" style="margin:.2rem 0 0"><span>Label</span><input type="text" id="ed-pl-label" value="${escapeAttr(pl.label || "Pocket")}"></label>`
        + `<div class="grid2" style="margin-top:8px">`
        + `<label class="fld" style="margin:0"><span>Width</span><input type="number" id="ed-pl-w" step="any" inputmode="decimal" value="${fmtVal(pl.w)}"></label>`
        + `<label class="fld" style="margin:0"><span>Height</span><input type="number" id="ed-pl-h" step="any" inputmode="decimal" value="${fmtVal(pl.h)}"></label>`
        + `</div>`
        + `<button class="btn small btn--ghost btn--block" data-action="ed-del-place" style="margin-top:10px">Remove guide</button>`;
      wirePlacement();
    } else if (sel.type === "curve" && activePiece() && activePiece().edges && activePiece().edges[String(sel.index)]) {
      const i = sel.index, n = ns.length, a = ns[i], b = ns[(i + 1) % n], chord = G.edgeLength(a, b);
      const c = activePiece().edges[String(i)].curve;
      const inSign = G.edgeInwardSign(ns, i), isInward = (c.cp[1] || 0) * inSign >= 0;
      const typeLabel = c.type === "cubic" ? "S-curve" : c.type === "arc" ? "Arc" : "Simple";
      const sideBtn = (lbl, key, on) => `<button class="btn small editor__toggle${on ? " on" : ""}" data-action="ed-curve-side" data-side="${key}">${lbl}</button>`;
      box.innerHTML =
        `<div class="row row--between"><strong>Curve on edge ${i + 1}</strong><span class="small muted">${unitLabel()}</span></div>`
        + `<label class="fld" style="margin:.4rem 0 0"><span>Bow depth (${unitShort()})</span>`
        + `<input type="number" id="ed-curve-depth" inputmode="decimal" step="any" min="0" value="${fmtVal(Math.abs(c.cp[1] || 0) * chord)}"></label>`
        + `<div class="btnrow" style="margin-top:8px">${sideBtn("Inward", "in", isInward)}${sideBtn("Outward", "out", !isInward)}</div>`
        + `<button class="btn small btn--ghost btn--block" data-action="ed-curve-type" style="margin-top:8px">Shape: ${typeLabel} (tap to change)</button>`
        + (c.type === "cubic" ? `<p class="small muted" style="margin:.3rem 0 0">Drag the second blue dot to shape the S-curve.</p>` : "")
        + `<button class="btn small btn--ghost btn--block" data-action="ed-del-curve" style="margin-top:8px">Remove curve</button>`;
      wireCurve();
    } else if (sel.type === "dart" && activePiece() && (activePiece().darts || [])[sel.index]) {
      const ap = activePiece(), d = ap.darts[sel.index], n = ap.nodes.length;
      const chord = G.edgeLength(ap.nodes[d.edge], ap.nodes[(d.edge + 1) % n]);
      const kindBtn = (lbl, key) => `<button class="btn small editor__toggle${d.kind === key ? " on" : ""}" data-action="ed-dart-kind" data-kind="${key}">${lbl}</button>`;
      box.innerHTML =
        `<div class="row row--between"><strong>Dart</strong><span class="small muted">${unitLabel()}</span></div>`
        + `<div class="grid2">`
        + `<label class="fld" style="margin:0"><span>Width (${unitShort()})</span><input type="number" id="ed-dart-width" inputmode="decimal" step="any" min="0" value="${fmtVal(d.width)}"></label>`
        + `<label class="fld" style="margin:0"><span>Depth (${unitShort()})</span><input type="number" id="ed-dart-depth" inputmode="decimal" step="any" min="0" value="${fmtVal(d.depth)}"></label>`
        + `</div>`
        + `<label class="fld" style="margin:.4rem 0 0"><span>Position along edge ${d.edge + 1} (${unitShort()})</span>`
        + `<input type="number" id="ed-dart-center" inputmode="decimal" step="any" min="0" value="${fmtVal(d.center * chord)}"></label>`
        + `<div class="btnrow" style="margin-top:8px">${kindBtn("Wedge (cut)", "wedge")}${kindBtn("Slash (fold)", "slash")}</div>`
        + `<button class="btn small btn--ghost btn--block" data-action="ed-del-dart" style="margin-top:8px">Remove dart</button>`;
      wireDart();
    } else {
      box.innerHTML = `<div class="empty">Tap a piece to edit it · drag a piece to move it · tap a corner or edge to adjust.</div>`;
    }
  }
  function wireDart() {
    const ap = activePiece(); if (!ap || !ap.darts) return;
    const d = ap.darts[state.selection.index]; if (!d) return;
    const n = ap.nodes.length, chord = G.edgeLength(ap.nodes[d.edge], ap.nodes[(d.edge + 1) % n]) || 1;
    const bind = (id, fn) => {
      const el = $(id); if (!el) return;
      const go = () => { const v = toMm(parseFloat(el.value)); if (isFinite(v)) { fn(v); commit(); render(); } };
      el.addEventListener("change", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); el.blur(); } });
    };
    bind("#ed-dart-width", (v) => { d.width = Math.max(1, G.round2(v)); });   // match clonePiece's floor (no undo snap)
    bind("#ed-dart-depth", (v) => { d.depth = Math.max(1, G.round2(v)); });
    bind("#ed-dart-center", (v) => { const m = Math.min(0.49, d.width / (2 * chord)); d.center = clamp(G.round2(v / chord), m, 1 - m); });
  }
  function setDartKind(k) {
    if (state.selection.type !== "dart") return;
    const ap = activePiece(), d = ap && ap.darts && ap.darts[state.selection.index]; if (!d) return;
    d.kind = k === "slash" ? "slash" : "wedge"; commit(); render();
  }
  function deleteDart() {
    if (state.selection.type !== "dart") return;
    const ap = activePiece(); if (!ap || !ap.darts) return;
    ap.darts.splice(state.selection.index, 1);
    if (!ap.darts.length) delete ap.darts;   // keep schema-2 byte-clean when the last dart goes
    select("none", -1); commit(); render();
  }
  function wireCurve() {
    const ap = activePiece(); if (!ap || !ap.edges) return;
    const i = state.selection.index, e = ap.edges[String(i)], c = e && e.curve; if (!c) return;
    const ns = ap.nodes, n = ns.length, chord = G.edgeLength(ns[i], ns[(i + 1) % n]) || 1;
    const el = $("#ed-curve-depth"); if (!el) return;
    const go = () => {
      const v = toMm(parseFloat(el.value));
      if (!isFinite(v) || v < 0) return;
      const curSign = (c.cp[1] || 0) * G.edgeInwardSign(ns, i) >= 0 ? G.edgeInwardSign(ns, i) : -G.edgeInwardSign(ns, i);
      c.cp[1] = G.round2(clamp((v / chord) * curSign, -1, 1));   // depth edits the PRIMARY handle only (cubic 2nd is dragged)
      commit(); render();
    };
    el.addEventListener("change", go);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go(); el.blur(); } });
  }
  // curve numeric-card actions (routed via data-action). type cycle resizes cp so cloneEdges keeps it.
  function cycleCurveType() {
    if (state.selection.type !== "curve") return;
    const ap = activePiece(); if (!ap || !ap.edges) return;
    const i = state.selection.index, e = ap.edges[String(i)], c = e && e.curve; if (!c) return;
    const order = ["quad", "cubic", "arc"], next = order[(order.indexOf(c.type) + 1) % order.length] || "quad";
    if (next === "cubic" && c.cp.length < 4) {
      const u = c.cp[0], v = c.cp[1];   // extend [u,v] → a valid 4-tuple (cloneEdges drops a cubic with <4 cp)
      c.cp = [G.round2(u * 0.66), v, G.round2(u + (1 - u) * 0.34), v];
    } else if (next !== "cubic" && c.cp.length > 2) {
      c.cp = c.cp.slice(0, 2);          // back to [u,v]
    }
    c.type = next; commit(); render();
  }
  function setCurveSide(side) {
    if (state.selection.type !== "curve") return;
    const ap = activePiece(); if (!ap || !ap.edges) return;
    const i = state.selection.index, e = ap.edges[String(i)], c = e && e.curve; if (!c) return;
    const want = (side === "in" ? 1 : -1) * G.edgeInwardSign(ap.nodes, i);
    c.cp[1] = G.round2((Math.abs(c.cp[1] || 0) || 0.15) * want);
    if (c.type === "cubic" && c.cp.length >= 4) c.cp[3] = G.round2((Math.abs(c.cp[3] || 0) || 0.15) * want);
    commit(); render();
  }
  function deleteCurve() {
    if (state.selection.type !== "curve") return;
    const ap = activePiece(); if (!ap || !ap.edges) return;
    delete ap.edges[String(state.selection.index)];
    if (!Object.keys(ap.edges).length) delete ap.edges;   // keep schema-2 byte-clean when the last curve goes
    select("none", -1); commit(); render();
  }
  function wirePlacement() {
    const ap = activePiece(); if (!ap) return;
    const pl = ap.placements[state.selection.index]; if (!pl) return;
    const bind = (id, fn) => {
      const el = $(id); if (!el) return;
      const go = () => { fn(el); commit(); render(); };
      el.addEventListener("change", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); el.blur(); } });
    };
    bind("#ed-pl-label", (el) => { pl.label = el.value.trim() || "Pocket"; });
    bind("#ed-pl-w", (el) => { const v = toMm(parseFloat(el.value)); if (isFinite(v) && v > 0) pl.w = G.round2(v); });
    bind("#ed-pl-h", (el) => { const v = toMm(parseFloat(el.value)); if (isFinite(v) && v > 0) pl.h = G.round2(v); });
  }
  function wireNumeric(sels) {
    const commitNow = () => commitNumeric();
    for (const sel of sels) {
      const el = $(sel); if (!el) continue;
      el.addEventListener("change", commitNow);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commitNow(); el.blur(); } });
    }
  }
  function commitNumeric() {
    const sel = state.selection, ns = nodes();
    if (sel.type === "vertex" && $("#ed-x")) {
      const x = toMm(parseFloat($("#ed-x").value)), y = toMm(parseFloat($("#ed-y").value));
      if (!isFinite(x) || !isFinite(y)) return;
      ns[sel.index].x = G.round2(x); ns[sel.index].y = G.round2(y);
      const rEl = $("#ed-radius");
      if (rEl) { const r = toMm(parseFloat(rEl.value)); ns[sel.index].radius = isFinite(r) && r > 0 ? G.round2(r) : 0; }
      const saEl = $("#ed-sa");
      if (saEl) { const sv = toMm(parseFloat(saEl.value)); ns[sel.index].saMm = isFinite(sv) && sv > 0 ? G.round2(sv) : 0; }   // 0 drops the field via clonePiece (schema-2 byte-clean)
      commit(); render();
    } else if (sel.type === "edge" && $("#ed-len")) {
      const L = toMm(parseFloat($("#ed-len").value));
      if (!isFinite(L) || L <= 0) return;
      const i = sel.index, n = ns.length, a = ns[i], j = (i + 1) % n, b = ns[j];
      let dx = b.x - a.x, dy = b.y - a.y, cur = Math.hypot(dx, dy);
      if (cur < 1e-6) { dx = 1; dy = 0; cur = 1; }
      ns[j].x = G.round2(a.x + (dx / cur) * L);
      ns[j].y = G.round2(a.y + (dy / cur) * L);
      commit(); render();
    }
  }

  // ── selection + readout ──────────────────────────────────────────────────────
  function select(type, index) { state.selection = { type, index }; setReadoutForSelection(); }
  function clampSelection() {
    const s = state.selection, ap = activePiece();
    if (s.type === "none") return;
    if (s.type === "curve") {   // index is a sparse edge key (node-start index), not a dense range
      const ok = ap && ap.edges && ap.edges[String(s.index)] && s.index < ap.nodes.length;
      if (!ok) state.selection = { type: "none", index: -1 };
      return;
    }
    let max;
    if (s.type === "seam") max = state.seams.length;
    else if (s.type === "vertex" || s.type === "edge") max = ap ? ap.nodes.length : 0;
    else if (s.type === "placement") max = ap ? ap.placements.length : 0;
    else if (s.type === "dart") max = ap ? (ap.darts || []).length : 0;
    else max = 0;
    if (s.index < 0 || s.index >= max) state.selection = { type: "none", index: -1 };
  }
  function setReadout(t) { if (readoutEl) readoutEl.textContent = t || ""; }
  function setReadoutForSelection() {
    const s = state.selection, ns = nodes();
    if (s.type === "vertex" && ns[s.index]) {
      const n = ns[s.index]; setReadout(`corner ${s.index + 1}: ${fmtVal(n.x)}, ${fmtVal(n.y)} ${unitShort()}`);
    } else if (s.type === "edge") {
      const i = s.index, n = ns.length; setReadout(`edge ${i + 1}: ${fmtLen(G.edgeLength(ns[i], ns[(i + 1) % n]))}`);
    } else if (s.type === "placement" && activePiece() && activePiece().placements[s.index]) {
      const pl = activePiece().placements[s.index]; setReadout(`${pl.label}: ${fmtVal(pl.w)} × ${fmtVal(pl.h)} ${unitShort()}`);
    } else if (s.type === "seam" && state.seams[s.index]) {
      const sm = state.seams[s.index], an = pieceById(sm.a.piece), bn = pieceById(sm.b.piece);
      setReadout(`seam: ${an ? an.name : "?"} ↔ ${bn ? bn.name : "?"}`);
    } else if (s.type === "dart" && activePiece() && (activePiece().darts || [])[s.index]) {
      const d = activePiece().darts[s.index]; setReadout(`dart: ${fmtVal(d.width)} × ${fmtVal(d.depth)} ${unitShort()}`);
    } else if (s.type === "curve" && activePiece() && activePiece().edges && activePiece().edges[String(s.index)]) {
      const i = s.index, n = ns.length, c = activePiece().edges[String(i)].curve;
      const depth = Math.abs((c.cp && c.cp[1]) || 0) * G.edgeLength(ns[i], ns[(i + 1) % n]);
      setReadout(`curve on edge ${i + 1}: depth ${fmtLen(depth)}`);
    } else setReadout("");
  }

  // ── history (undo/redo) ──────────────────────────────────────────────────────
  const editSnapshot = () => JSON.stringify({ pieces: state.pieces, active: state.active, name: state.name, seams: state.seams, body: state.body });
  function resetHistory() { state.history = [editSnapshot()]; state.hindex = 0; }
  function commit() {
    state.history = state.history.slice(0, state.hindex + 1);
    state.history.push(editSnapshot()); state.hindex = state.history.length - 1;
    if (state.history.length > 100) { state.history.shift(); state.hindex--; }
  }
  function restore(snap) {
    const o = JSON.parse(snap);
    geomCacheMap.clear();
    // Route through the canonical normalizePieces/clonePiece so every field (incl. schema-3
    // edges/darts/place3d/saMm + upgraded notches) survives undo — the single source of truth.
    state.pieces = G.normalizePieces({ pieces: o.pieces || [] });
    if (!state.pieces.length) state.pieces = [G.rectPiece("Piece 1", 300, 400)];
    ensurePieceIds();
    state.seams = G.normalizeSeams(o.seams || [], state.pieces);   // drop any refs the undo invalidated
    // body must reflect the snapshot exactly (NOT fall back to the live body) or toggling the garment
    // OFF can't be undone — a snapshot with no body legitimately means "not a garment".
    state.body = o.body ? G.normalizeBody(o.body) : null;
    state.active = Math.min(o.active || 0, state.pieces.length - 1);
    state.name = o.name || ""; if (nameInput) nameInput.value = state.name;
    clampSelection();
    setReadoutForSelection();   // so undo doesn't leave a stale/lying readout
    render();
  }
  function undo() { if (state.hindex > 0) { state.hindex--; restore(state.history[state.hindex]); } }
  function redo() { if (state.hindex < state.history.length - 1) { state.hindex++; restore(state.history[state.hindex]); } }
  function updateButtons() {
    const u = $("[data-action='ed-undo']"), r = $("[data-action='ed-redo']");
    if (u) u.disabled = state.hindex <= 0;
    if (r) r.disabled = state.hindex >= state.history.length - 1;
  }

  // ── hit-testing (screen space; active-piece geometry is board-offset) ────────
  function hitVertex(p) {
    const ns = nodes(); let best = -1, bestD = HIT_VERTEX;
    for (let i = 0; i < ns.length; i++) {
      const s = W2S(aB(ns[i]));
      const d = Math.hypot(p.sx - s.sx, p.sy - s.sy);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function hitEdge(p) {
    const ns = nodes(), n = ns.length; let best = -1, bestD = HIT_EDGE;
    for (let i = 0; i < n; i++) {
      const a = W2S(aB(ns[i])), b = W2S(aB(ns[(i + 1) % n]));
      const d = G.pointToSegmentDist({ x: p.sx, y: p.sy }, { x: a.sx, y: a.sy }, { x: b.sx, y: b.sy });
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function hitPlacement(p) {
    const ap = activePiece(); if (!ap) return -1;
    const L = activeLayout(), w = S2W(p.sx, p.sy);
    for (let i = ap.placements.length - 1; i >= 0; i--) {
      const pl = ap.placements[i];
      if (w.x >= pl.x + L.x && w.x <= pl.x + pl.w + L.x && w.y >= pl.y + L.y && w.y <= pl.y + pl.h + L.y) return i;
    }
    return -1;
  }
  // notch center in LOCAL coords — the analytic t-point for an upgraded notch (centered for a double),
  // else the legacy {x,y}'s projection onto the nearest edge.
  function notchCenterLocal(ap, nt) {
    const ns = ap.nodes, n = ns.length;
    if (Number.isInteger(nt.edge) && nt.edge >= 0 && nt.edge < n) {
      const a = ns[nt.edge], b = ns[(nt.edge + 1) % n], t = Math.max(0, Math.min(1, nt.t || 0));
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    }
    const m = G.notchMark(ns, nt); return m ? { x: (m[0][0] + m[1][0]) / 2, y: (m[0][1] + m[1][1]) / 2 } : null;
  }
  function hitNotch(p) {
    const ap = activePiece(); if (!ap) return -1;
    const L = activeLayout(); let best = -1, bestD = 18;
    for (let i = 0; i < ap.notches.length; i++) {
      const c = notchCenterLocal(ap, ap.notches[i]); if (!c) continue;
      const s = W2S({ x: c.x + L.x, y: c.y + L.y });
      const d = Math.hypot(p.sx - s.sx, p.sy - s.sy);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function hitPiece(p) {
    const w = S2W(p.sx, p.sy);
    if (activePiece() && pointInPoly(w.x, w.y, pieceBoardNodes(activePiece()))) return state.active;
    for (let i = state.pieces.length - 1; i >= 0; i--) {
      if (i === state.active) continue;
      if (pointInPoly(w.x, w.y, pieceBoardNodes(state.pieces[i]))) return i;
    }
    return -1;
  }
  function snapWorld(w) { return state.snapOn ? G.snapPoint(w, state.gridMm) : { x: G.round1(w.x), y: G.round1(w.y) }; }
  const boardToLocal = (b) => { const L = activeLayout(); return { x: b.x - L.x, y: b.y - L.y }; };

  // curve control-dot hit-test (screen space). Sets curveHitSlot to which cp slot (0 primary, 2 cubic-2).
  const HIT_CURVE = 17;
  function hitCurve(p) {
    const ap = activePiece(); if (!ap || !ap.edges) return -1;
    const ns = ap.nodes, n = ns.length; let best = -1, bestD = HIT_CURVE, bestSlot = 0;
    for (const k of Object.keys(ap.edges)) {
      const i = parseInt(k, 10); if (!(i >= 0 && i < n)) continue;
      const c = ap.edges[k].curve; if (!c || !Array.isArray(c.cp)) continue;
      const a = ns[i], b = ns[(i + 1) % n];
      for (const sl of (c.type === "cubic" ? [0, 2] : [0])) {
        const wl = G.edgeLocalToWorld(a, b, c.cp[sl], c.cp[sl + 1]);
        const s = W2S(aB({ x: wl[0], y: wl[1] }));
        const d = Math.hypot(p.sx - s.sx, p.sy - s.sy);
        if (d <= bestD) { bestD = d; best = i; bestSlot = sl; }
      }
    }
    curveHitSlot = bestSlot;
    return best;
  }
  // Dart apex in LOCAL coords — same inward-normal as loweredBoundary, so the handle sits on the
  // printed dart tip. Returns the apex {x,y} plus its base (the edge point at `center`). Single source
  // of truth shared by render + hit-test + drag.
  function dartApexLocal(piece, d) {
    const ns = piece.nodes, n = ns.length; if (d.edge < 0 || d.edge >= n) return null;
    let cx = 0, cy = 0; for (const q of ns) { cx += q.x; cy += q.y; } cx /= n; cy /= n;
    const a = ns[d.edge], b = ns[(d.edge + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    let nx = -dy / L, ny = dx / L;
    const cDist = d.center * L, mx = a.x + cDist * ux, my = a.y + cDist * uy;
    if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }   // inward (toward centroid)
    return { x: mx + nx * d.depth, y: my + ny * d.depth, base: { x: mx, y: my } };
  }
  const HIT_DART = 17;
  function hitDart(p) {
    const ap = activePiece(); if (!ap || !ap.darts) return -1;
    let best = -1, bestD = HIT_DART;
    for (let i = 0; i < ap.darts.length; i++) {
      const apex = dartApexLocal(ap, ap.darts[i]); if (!apex) continue;
      const s = W2S(aB(apex)), d = Math.hypot(p.sx - s.sx, p.sy - s.sy);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }
  // Curve-mode tap: hit a dot → select it; else hit a straight edge → bow it (a gentle inward default).
  function handleCurveTap(p) {
    const ap = activePiece(); if (!ap) return;
    const ci = hitCurve(p);
    if (ci >= 0) { select("curve", ci); render(); return; }
    const ei = hitEdge(p);
    if (ei < 0) { select("none", -1); scheduleRender(); return; }
    ap.edges = ap.edges || {};
    if (!ap.edges[String(ei)]) {
      ap.edges[String(ei)] = { curve: { type: "quad", cp: [0.5, G.round2(0.15 * G.edgeInwardSign(ap.nodes, ei))] } };
      commit();
    }
    select("curve", ei); render();
  }
  // Dart-mode tap: hit an apex → select it; else hit an edge → drop a wedge dart there.
  function handleDartTap(p) {
    const ap = activePiece(); if (!ap) return;
    const di = hitDart(p);
    if (di >= 0) { select("dart", di); render(); return; }
    const L = activeLayout(), wl = S2W(p.sx, p.sy);
    const ne = G.nearestEdge(ap.nodes, { x: wl.x - L.x, y: wl.y - L.y });
    const pr = G.worldToScreen(ne.proj.x + L.x, ne.proj.y + L.y, state.cam);
    if (Math.hypot(p.sx - pr.sx, p.sy - pr.sy) > 28) { setStatus("Tap on an edge to add a dart.", "warn"); clearStatus(2500); return; }
    ap.darts = ap.darts || [];
    const id = freshId("d", new Set(ap.darts.map((d) => d.id)));
    ap.darts.push({ id, edge: ne.edge, center: G.round2(ne.proj.t), width: 26, depth: 120, kind: "wedge" });
    select("dart", ap.darts.length - 1); commit(); render();
  }
  function handleNotchTap(p) {
    const ap = activePiece(); if (!ap) return;
    const ri = hitNotch(p);
    if (ri >= 0) {   // cycle single → double → remove
      const nt = ap.notches[ri];
      if (Number.isInteger(nt.edge) && nt.type === "single") { nt.type = "double"; commit(); setStatus("Notch → double (passmark).", "info"); }
      else { ap.notches.splice(ri, 1); commit(); setStatus("Notch removed.", "info"); }
      clearStatus(2000); return;
    }
    const L = activeLayout(), wl = S2W(p.sx, p.sy);
    const ne = G.nearestEdge(ap.nodes, { x: wl.x - L.x, y: wl.y - L.y });
    const pr = G.worldToScreen(ne.proj.x + L.x, ne.proj.y + L.y, state.cam);
    if (Math.hypot(p.sx - pr.sx, p.sy - pr.sy) > 28) { setStatus("Tap on an edge to add a notch.", "warn"); clearStatus(2500); return; }
    ap.notches.push({ edge: ne.edge, t: G.round2(ne.proj.t), type: "single" });   // upgraded {edge,t,type}
    commit();
  }
  function addPlacement() {
    const ap = activePiece(); if (!ap) return;
    const bb = G.bbox(ap.nodes.map((n) => [n.x, n.y]));
    const w = Math.min(160, Math.max(40, bb.w * 0.5)), h = Math.min(180, Math.max(40, bb.h * 0.4));
    ap.placements.push({ x: G.round2(bb.minX + (bb.w - w) / 2), y: G.round2(bb.minY + (bb.h - h) / 2), w: G.round2(w), h: G.round2(h), label: "Pocket" });
    select("placement", ap.placements.length - 1); commit(); render();
  }
  function deletePlacement() {
    const ap = activePiece(); if (!ap || state.selection.type !== "placement") return;
    ap.placements.splice(state.selection.index, 1); select("none", -1); commit(); render();
  }
  function insertOnEdge(ei, p) {
    const ns = nodes(), n = ns.length, a = ns[ei], b = ns[(ei + 1) % n];
    const as = W2S(aB(a)), bs = W2S(aB(b));
    const pr = G.projectPointOnSegment({ x: p.sx, y: p.sy }, { x: as.sx, y: as.sy }, { x: bs.sx, y: bs.sy });
    const w = boardToLocal(snapWorld(S2W(pr.x, pr.y)));
    const splitCurved = featureOnEdge(activePiece(), ei);
    activePiece().nodes = G.insertVertexOnEdge(ns, ei, { x: G.round2(w.x), y: G.round2(w.y) });
    reindexSeamsForInsert(activePiece().id, ei);
    commit(); select("vertex", ei + 1);
    if (splitCurved) { setStatus("Heads up — adding a point on a curved/darted edge reshapes it.", "warn"); clearStatus(3500); }
  }
  // true if the piece has a curve, dart, or upgraded notch on authored edge `edge`.
  function featureOnEdge(ap, edge) {
    return !!((ap.edges && ap.edges[String(edge)])
      || (ap.darts || []).some((d) => d.edge === edge)
      || (ap.notches || []).some((nt) => Number.isInteger(nt.edge) && nt.edge === edge));
  }
  function deleteSelected() {
    if (!canEdit()) return;
    if (state.selection.type !== "vertex") { setStatus("Select a corner first, then Delete.", "warn"); clearStatus(3000); return; }
    if (nodes().length <= 3) { setStatus("A shape needs at least 3 corners.", "warn"); clearStatus(3000); return; }
    const ap = activePiece(), k = state.selection.index, nn = nodes().length;
    const adjFeature = featureOnEdge(ap, k) || featureOnEdge(ap, (k - 1 + nn) % nn);   // the two edges that merge
    reindexSeamsForDelete(ap.id, k);
    nodes().splice(k, 1);
    commit(); select("none", -1); scheduleRender();
    if (adjFeature) { setStatus("Heads up — deleting this point reshaped a nearby curve, dart, or notch.", "warn"); clearStatus(3500); }
  }
  // edge-insert / notch / deselect when a tap lands on (or near) the active piece
  function resolveActiveTap(p) {
    if (!canEdit()) { select("none", -1); return; }
    const ei = hitEdge(p);
    if (ei >= 0) { insertOnEdge(ei, p); return; }
    select("none", -1);
  }

  // ── seams (Sew mode) ─────────────────────────────────────────────────────────
  const pieceIndexById = (id) => state.pieces.findIndex((p) => p.id === id);
  const pieceById = (id) => state.pieces.find((p) => p.id === id) || null;
  function freshId(prefix, taken) { let c = 1, id; do { id = prefix + (c++); } while (taken.has(id)); return id; }
  function ensurePieceIds() {
    const used = new Set(state.pieces.map((p) => p.id).filter(Boolean));
    for (const p of state.pieces) if (!p.id) { p.id = freshId("p", used); used.add(p.id); }
  }
  function freshPieceId() { return freshId("p", new Set(state.pieces.map((p) => p.id).filter(Boolean))); }
  // Keep seam edge-refs valid when a piece's node count changes (insert/delete a corner):
  // inserting after edge ei pushes higher edges up; deleting node k drops edge k and pulls
  // higher edges down. Seams attached to the deleted edge are removed.
  function reindexSeamsForInsert(pieceId, ei) {
    for (const s of state.seams) for (const ref of [s.a, s.b]) if (ref.piece === pieceId && ref.edge > ei) ref.edge += 1;
    G.reindexEdgeRefs(pieceById(pieceId), { kind: "insert", ei });   // keep darts/curves/notches on the same piece in lockstep
  }
  function reindexSeamsForDelete(pieceId, k) {
    state.seams = state.seams.filter((s) => !((s.a.piece === pieceId && s.a.edge === k) || (s.b.piece === pieceId && s.b.edge === k)));
    for (const s of state.seams) for (const ref of [s.a, s.b]) if (ref.piece === pieceId && ref.edge > k) ref.edge -= 1;
    G.reindexEdgeRefs(pieceById(pieceId), { kind: "delete", k });
  }

  function edgeEndpointsScreen(ref) {
    const p = pieceById(ref.piece); if (!p) return null;
    const L = layoutOf(p), n = p.nodes.length, a = p.nodes[ref.edge], b = p.nodes[(ref.edge + 1) % n];
    if (!a || !b) return null;
    return { a: W2S({ x: a.x + L.x, y: a.y + L.y }), b: W2S({ x: b.x + L.x, y: b.y + L.y }) };
  }
  function edgeMidScreen(ref) { const e = edgeEndpointsScreen(ref); return e ? { sx: (e.a.sx + e.b.sx) / 2, sy: (e.a.sy + e.b.sy) / 2 } : null; }

  // Nearest authored node-edge across ALL pieces (sew is cross-piece). Returns {piece:<id>, edge}.
  function hitEdgeAny(p) {
    let best = null, bestD = HIT_EDGE;
    for (const pc of state.pieces) {
      const L = layoutOf(pc), n = pc.nodes.length;
      for (let i = 0; i < n; i++) {
        const a = W2S({ x: pc.nodes[i].x + L.x, y: pc.nodes[i].y + L.y });
        const b = W2S({ x: pc.nodes[(i + 1) % n].x + L.x, y: pc.nodes[(i + 1) % n].y + L.y });
        const d = G.pointToSegmentDist({ x: p.sx, y: p.sy }, { x: a.sx, y: a.sy }, { x: b.sx, y: b.sy });
        if (d <= bestD) { bestD = d; best = { piece: pc.id, edge: i }; }
      }
    }
    return best;
  }
  function hitSeam(p) {
    let best = -1, bestD = 16;
    for (let i = 0; i < state.seams.length; i++) {
      const ma = edgeMidScreen(state.seams[i].a), mb = edgeMidScreen(state.seams[i].b);
      if (!ma || !mb) continue;
      const d = G.pointToSegmentDist({ x: p.sx, y: p.sy }, { x: ma.sx, y: ma.sy }, { x: mb.sx, y: mb.sy });
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function handleSewTap(p) {
    const si = hitSeam(p);
    if (si >= 0) { state.sewPending = null; selectSeam(si); return; }
    const hit = hitEdgeAny(p);
    if (!hit) { state.sewPending = null; select("none", -1); scheduleRender(); return; }
    if (!state.sewPending) {
      state.sewPending = hit;
      setStatus("Now tap the matching edge on another piece.", "info");
      scheduleRender(); return;
    }
    if (state.sewPending.piece === hit.piece && state.sewPending.edge === hit.edge) {
      state.sewPending = null; setStatus("Seam cancelled.", "info"); clearStatus(1500); scheduleRender(); return;
    }
    addSeam(state.sewPending, hit); state.sewPending = null;
  }
  function addSeam(a, b) {
    const id = freshId("s", new Set(state.seams.map((s) => s.id)));
    state.seams.push({ id, a: { piece: a.piece, edge: a.edge }, b: { piece: b.piece, edge: b.edge }, foldAngle: null, anchors: null });
    commit(); selectSeam(state.seams.length - 1);
    setStatus("Seam added.", "good"); clearStatus(2000);
  }
  function selectSeam(i) { state.selection = { type: "seam", index: i }; setReadoutForSelection(); render(); }
  function deleteSeam() {
    if (state.selection.type !== "seam") return;
    state.seams.splice(state.selection.index, 1); select("none", -1); commit(); render();
  }
  function setSeamAngle(v) {
    if (state.selection.type !== "seam") return;
    const s = state.seams[state.selection.index]; if (!s) return;
    s.foldAngle = v === "null" ? null : parseFloat(v);
    commit(); render();
  }
  // Which way the two edges meet. The fold auto-searches this, but if it guesses wrong
  // (the bag folds inside-out) she can pin it. anchors encodes it: head-to-tail pairs
  // t=0↔t=1, head-to-head pairs t=0↔t=0; null = let the fold decide. Cycles auto→fwd→flip.
  function seamDir(s) {
    if (!s.anchors || !s.anchors[0]) return "auto";
    return Math.abs(s.anchors[0].ta - s.anchors[0].tb) < 0.5 ? "flip" : "fwd";
  }
  function setSeamFlip() {
    if (state.selection.type !== "seam") return;
    const s = state.seams[state.selection.index]; if (!s) return;
    const cur = seamDir(s);
    s.anchors = cur === "auto" ? [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }]
      : cur === "fwd" ? [{ ta: 0, tb: 0 }, { ta: 1, tb: 1 }]
        : null;
    commit(); render();
  }
  // ── draw-mode exclusivity (notch / sew / curve / dart are mutually exclusive) ─────────────────
  const MODES = ["notchMode", "sewMode", "curveMode", "dartMode"];
  function noModeOn() { return !state.notchMode && !state.sewMode && !state.curveMode && !state.dartMode; }
  function updateSelectChip() { const c = $("#ed-select"); if (c) c.classList.toggle("on", noModeOn()); }
  function updateModeHint() {
    const el = $("#ed-modehint"); if (!el) return;
    el.textContent =
      state.notchMode ? "Notch — tap an edge to add a notch; tap a notch to remove it."
      : state.sewMode  ? "Sew — tap an edge on one piece, then a matching edge on another, to join them."
      : state.curveMode ? "Curve — tap a straight edge to bow it; drag the blue dot to shape it."
      : state.dartMode ? "Dart — tap an edge to add a dart; drag the pink dot to set its depth."
      : "Select & edit — drag a corner, tap an edge to add a point, type an exact size.";
  }
  function syncModeChips() { updateNotchChip(); updateSewChip(); updateCurveChip(); updateDartChip(); updateSelectChip(); updateModeHint(); }
  // Turn mode m on (clearing the other three), or all-off if m was already on (toggle). One source of
  // truth so chips never desync; any switch abandons a pending sew. render() because overlays read mode.
  function setMode(m) {
    const turningOn = m && !state[m];
    for (const k of MODES) state[k] = false;
    if (turningOn) state[m] = true;
    state.sewPending = null;
    syncModeChips();
    render();
  }
  function toggleSew() {
    setMode("sewMode");
    if (state.sewMode) { setStatus("Sew mode: tap an edge on one piece, then a matching edge on another, to join them.", "info"); clearStatus(4500); }
  }
  function updateSewChip() { const c = $("#ed-seam"); if (c) c.classList.toggle("on", state.sewMode); }
  function updateCurveChip() { const c = $("#ed-curve"); if (c) c.classList.toggle("on", state.curveMode); }
  function updateDartChip() { const c = $("#ed-dart"); if (c) c.classList.toggle("on", state.dartMode); }
  function toggleCurve() {
    setMode("curveMode");
    if (state.curveMode) { setStatus("Curve mode: tap a straight edge to bow it (a neckline, armhole, A-line); drag the blue dot to shape it.", "info"); clearStatus(4500); }
  }
  function toggleDart() {
    setMode("dartMode");
    if (state.dartMode) { setStatus("Dart mode: tap an edge to add a dart; drag the pink dot to set its depth.", "info"); clearStatus(4500); }
  }
  function renderSeamList() {
    const list = $("#ed-seams");
    if (list) {
      if (!state.seams.length) {
        list.innerHTML = `<div class="empty">No seams yet. Turn on <strong>Sew</strong>, then tap an edge on one piece and the matching edge on another.</div>`;
      } else {
        list.innerHTML = state.seams.map((s, i) => {
          const an = pieceById(s.a.piece), bn = pieceById(s.b.piece);
          const sel = state.selection.type === "seam" && state.selection.index === i;
          return `<button class="piece-row${sel ? " on" : ""}" data-action="ed-select-seam" data-seam="${i}">`
            + `<span class="piece-row__name">${escapeHtml(an ? an.name : "?")} ↔ ${escapeHtml(bn ? bn.name : "?")}</span>`
            + `<span class="piece-row__meta">edges ${s.a.edge + 1} · ${s.b.edge + 1}${s.foldAngle != null ? " · " + s.foldAngle + "°" : ""}</span>`
            + `</button>`;
        }).join("");
      }
    }
    const ed = $("#ed-seam-edit"); if (!ed) return;
    const s = state.selection.type === "seam" ? state.seams[state.selection.index] : null;
    if (!s) { ed.innerHTML = ""; return; }
    const ang = s.foldAngle;
    const ab = (v, label) => `<button class="btn small editor__toggle${(v === "null" ? ang == null : ang === parseFloat(v)) ? " on" : ""}" data-action="ed-seam-angle" data-angle="${v}">${label}</button>`;
    const dir = seamDir(s), dirLabel = dir === "auto" ? "Auto" : dir === "fwd" ? "Forward" : "Flipped";
    ed.innerHTML = `<div class="small muted" style="margin-bottom:6px">Fold angle <span class="muted">(used by the 3D fold)</span></div>`
      + `<div class="btnrow">${ab("0", "Flat")}${ab("90", "90°")}${ab("180", "Fold")}${ab("null", "Auto")}</div>`
      + `<button class="btn small btn--ghost btn--block${dir !== "auto" ? " on" : ""}" data-action="ed-seam-flip" style="margin-top:8px">Direction: ${dirLabel}</button>`
      + `<button class="btn small btn--ghost btn--block" data-action="ed-del-seam" style="margin-top:8px">Delete seam</button>`;
  }

  // ── pointer interaction ──────────────────────────────────────────────────────
  const pointers = new Map();
  let mode = "idle", dragIndex = -1, dragMoved = false, panStart = null, pinchStart = null;
  let placeIndex = -1, placeGrab = null, pieceMove = null;
  let curveDrag = null, curveHitSlot = 0;   // curve control-dot being dragged + which cp slot (0 or 2)

  function localPoint(e) { const r = svg.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }

  function onDown(e) {
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    const p = localPoint(e); pointers.set(e.pointerId, p);
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;
    if (state.sewMode) {   // sewing: a tap picks edges/seams; a drag still pans
      mode = "maybeSew"; panStart = { sx: p.sx, sy: p.sy, cam: Object.assign({}, state.cam) };
      return;
    }
    // Draw modes (notch/curve/dart) commandeer the tap like sew mode does — skipping the corner/
    // placement/piece hit ladder so a tap near a corner can't accidentally start a vertex drag.
    // Each first grabs its OWN handle for a drag (curve/dart), else falls to a tap that places/cycles.
    if (state.curveMode) {
      const ci = hitCurve(p);
      if (ci >= 0) { mode = "dragCurve"; curveDrag = { edge: ci, slot: curveHitSlot }; dragMoved = false; select("curve", ci); scheduleRender(); return; }
      mode = "maybeCurve"; panStart = { sx: p.sx, sy: p.sy, cam: Object.assign({}, state.cam) };
      return;
    }
    if (state.dartMode) {
      const di = hitDart(p);
      if (di >= 0) { mode = "dragDart"; dragIndex = di; dragMoved = false; select("dart", di); scheduleRender(); return; }
      mode = "maybeDart"; panStart = { sx: p.sx, sy: p.sy, cam: Object.assign({}, state.cam) };
      return;
    }
    if (state.notchMode) {   // notch: a tap adds/cycles a notch; a drag still pans
      mode = "maybeNotch"; panStart = { sx: p.sx, sy: p.sy, cam: Object.assign({}, state.cam) };
      return;
    }
    if (canEdit()) {
      const vi = hitVertex(p);
      if (vi >= 0) { mode = "drag"; dragIndex = vi; dragMoved = false; select("vertex", vi); scheduleRender(); return; }
      const pli = hitPlacement(p);
      if (pli >= 0) {
        const L = activeLayout(), w = S2W(p.sx, p.sy), pl = activePiece().placements[pli];
        mode = "dragPlace"; placeIndex = pli; placeGrab = { dx: w.x - (pl.x + L.x), dy: w.y - (pl.y + L.y) }; dragMoved = false;
        select("placement", pli); scheduleRender(); return;
      }
    }
    const pi = hitPiece(p);
    if (pi >= 0) {
      const switched = pi !== state.active;
      if (switched) { state.active = pi; select("none", -1); }
      const w = S2W(p.sx, p.sy), L = layoutOf(state.pieces[pi]);
      mode = "maybePiece"; pieceMove = { idx: pi, switched, grabX: w.x - L.x, grabY: w.y - L.y, downSx: p.sx, downSy: p.sy };
      dragMoved = false; scheduleRender(); return;
    }
    mode = "maybePan"; panStart = { sx: p.sx, sy: p.sy, cam: Object.assign({}, state.cam) };
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localPoint(e); pointers.set(e.pointerId, p);
    if (mode === "pinch") { updatePinch(); return; }
    if (mode === "drag") {
      const w = boardToLocal(snapWorld(S2W(p.sx, p.sy)));
      nodes()[dragIndex].x = G.round2(w.x); nodes()[dragIndex].y = G.round2(w.y); dragMoved = true;
      setReadout(`corner ${dragIndex + 1}: ${fmtVal(w.x)}, ${fmtVal(w.y)} ${unitShort()}`);
      scheduleRender(); return;
    }
    if (mode === "dragPlace") {
      const L = activeLayout(), w = S2W(p.sx, p.sy);
      const sp = snapWorld({ x: w.x - placeGrab.dx, y: w.y - placeGrab.dy });
      const pl = activePiece().placements[placeIndex];
      pl.x = G.round2(sp.x - L.x); pl.y = G.round2(sp.y - L.y); dragMoved = true;
      setReadout(`${pl.label}: ${fmtVal(pl.x)}, ${fmtVal(pl.y)} ${unitShort()}`);
      scheduleRender(); return;
    }
    if (mode === "dragCurve") {
      const ap = activePiece(), i = curveDrag.edge, n = ap.nodes.length;
      const c = ap.edges && ap.edges[String(i)] && ap.edges[String(i)].curve;
      if (c) {
        const a = ap.nodes[i], b = ap.nodes[(i + 1) % n];
        const w = boardToLocal(S2W(p.sx, p.sy));   // no snap — smooth bow control
        const uv = G.worldToEdgeLocal(a, b, w), sl = curveDrag.slot;
        c.cp[sl] = G.round2(clamp(uv[0], 0, 1));        // along-edge ∈ [0,1]
        c.cp[sl + 1] = G.round2(clamp(uv[1], -1, 1));   // normal bow — clamp so a stray drag can't explode the board
        dragMoved = true; setReadoutForSelection();
      }
      scheduleRender(); return;
    }
    if (mode === "dragDart") {   // depth only — center is set via the numeric card (avoids finger-jitter slide)
      const ap = activePiece(), d = ap.darts && ap.darts[dragIndex], n = ap.nodes.length;
      if (d) {
        const a = ap.nodes[d.edge], b = ap.nodes[(d.edge + 1) % n], L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const uv = G.worldToEdgeLocal(a, b, boardToLocal(S2W(p.sx, p.sy)));
        d.depth = G.round2(clamp(Math.abs(uv[1]) * L, 1, 0.45 * L));   // |v|·L = mm; clamp so it can't degenerate/explode
        dragMoved = true; setReadoutForSelection();
      }
      scheduleRender(); return;
    }
    if (mode === "maybePiece") {
      if (Math.hypot(p.sx - pieceMove.downSx, p.sy - pieceMove.downSy) > MOVE_TOL) mode = "dragPiece";
    }
    if (mode === "dragPiece") {
      const w = S2W(p.sx, p.sy);
      const sp = snapWorld({ x: w.x - pieceMove.grabX, y: w.y - pieceMove.grabY });
      const pc = state.pieces[pieceMove.idx];
      pc.layout = { x: G.round2(sp.x), y: G.round2(sp.y) }; dragMoved = true;
      setReadout(`${pc.name}: ${fmtVal(pc.layout.x)}, ${fmtVal(pc.layout.y)} ${unitShort()}`);
      scheduleRender(); return;
    }
    if (mode === "maybePan" || mode === "maybeSew" || mode === "maybeNotch" || mode === "maybeCurve" || mode === "maybeDart") {
      if (Math.hypot(p.sx - panStart.sx, p.sy - panStart.sy) > MOVE_TOL) mode = "pan";
    }
    if (mode === "pan") {
      state.cam.tx = panStart.cam.tx + (p.sx - panStart.sx);
      state.cam.ty = panStart.cam.ty + (p.sy - panStart.sy);
      scheduleRender();
    }
  }
  function onUp(e) {
    const p = pointers.get(e.pointerId) || localPoint(e);
    pointers.delete(e.pointerId);
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    if (mode === "pinch") {
      if (pointers.size === 1) { const rem = [...pointers.values()][0]; mode = "pan"; panStart = { sx: rem.sx, sy: rem.sy, cam: Object.assign({}, state.cam) }; }
      else mode = "idle";
      return;
    }
    if (mode === "drag") { if (dragMoved) commit(); else setReadoutForSelection(); dragIndex = -1; mode = "idle"; scheduleRender(); return; }
    if (mode === "dragPlace") { if (dragMoved) commit(); placeIndex = -1; mode = "idle"; scheduleRender(); return; }
    if (mode === "dragPiece") { if (dragMoved) { commit(); warnIfOverlap(); } mode = "idle"; scheduleRender(); return; }
    if (mode === "dragCurve") { if (dragMoved) commit(); curveDrag = null; mode = "idle"; scheduleRender(); return; }
    if (mode === "dragDart") { if (dragMoved) commit(); dragIndex = -1; mode = "idle"; scheduleRender(); return; }
    if (mode === "maybeSew") { handleSewTap(p); mode = "idle"; scheduleRender(); return; }
    if (mode === "maybeNotch") { handleNotchTap(p); mode = "idle"; scheduleRender(); return; }
    if (mode === "maybeCurve") { handleCurveTap(p); mode = "idle"; scheduleRender(); return; }
    if (mode === "maybeDart") { handleDartTap(p); mode = "idle"; scheduleRender(); return; }
    if (mode === "maybePiece") {
      if (pieceMove.switched) { fitPiece(pieceMove.idx); render(); }   // tapped another piece → select + zoom in
      else resolveActiveTap(p);                                         // tapped the active piece → edit
      mode = "idle"; scheduleRender(); return;
    }
    if (mode === "maybePan") { resolveActiveTap(p); scheduleRender(); }
    mode = "idle";
  }
  function onCancel(e) {
    pointers.delete(e.pointerId);
    if ((mode === "drag" || mode === "dragPlace" || mode === "dragPiece" || mode === "dragCurve" || mode === "dragDart") && dragMoved) restore(state.history[state.hindex]);
    mode = "idle"; dragIndex = -1; placeIndex = -1; pieceMove = null; curveDrag = null; scheduleRender();
  }
  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(b.sx - a.sx, b.sy - a.sy), mid: { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 }, cam: Object.assign({}, state.cam) };
    mode = "pinch"; dragIndex = -1; dragMoved = false; pieceMove = null;
  }
  function updatePinch() {
    const vals = [...pointers.values()]; if (vals.length < 2) return;
    const [a, b] = vals;
    const dist = Math.hypot(b.sx - a.sx, b.sy - a.sy), mid = { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 };
    const k = clamp(pinchStart.cam.k * (dist / pinchStart.dist), K_MIN, K_MAX);
    const wA = G.screenToWorld(pinchStart.mid.sx, pinchStart.mid.sy, pinchStart.cam);
    state.cam = { k, tx: mid.sx - k * wA.x, ty: mid.sy + k * wA.y };
    scheduleRender();
  }
  function onWheel(e) {
    e.preventDefault();
    const p = localPoint(e);
    const k = clamp(state.cam.k * Math.exp(-e.deltaY * 0.0015), K_MIN, K_MAX);
    const w = S2W(p.sx, p.sy);
    state.cam = { k, tx: p.sx - k * w.x, ty: p.sy + k * w.y };
    scheduleRender();
  }

  // ── build / save / print ────────────────────────────────────────────────────
  function buildDoc() {
    return G.freeformToDoc({ pieces: state.pieces, seams: state.seams, body: state.body, name: (nameInput.value || "Untitled").trim() || "Untitled", gridMm: state.gridMm });
  }
  async function buildTiled(doc) {
    try { return await PDF.makeTiledPdf(doc); }
    catch (_) { setStatus("That layout is too large for Letter sheets — make the pieces smaller or Auto-arrange.", "bad"); return null; }
  }
  async function save() {
    if (!state.pieces.length) { setStatus("Nothing to save yet.", "warn"); clearStatus(3000); return; }
    const doc = buildDoc();
    const body = { name: doc.name, kind: "freeform", params: doc };
    if (state.id) body.id = state.id;
    let r; try { r = await fetch(api("/patterns"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch { r = null; }
    if (r && r.ok) {
      const d = await r.json().catch(() => ({}));
      if (d.id) { const wasNew = !state.id; state.id = d.id; if (wasNew) try { history.replaceState(null, "", api("/edit/" + d.id)); } catch (_) {} }
      setStatus("Saved.", "good"); clearStatus(3000);
    } else setStatus("Couldn't save — try again.", "bad");
  }
  async function doDownload() {
    const doc = buildDoc(); setStatus("Building the pattern…", "info");
    const res = await buildTiled(doc); if (!res) return;
    download(res.bytes, (doc.name || "pattern").replace(/\s+/g, "-") + ".pdf");
    setStatus(`Downloaded — ${res.sheets} sheet${res.sheets > 1 ? "s" : ""}. Print at 100% / Actual Size.`, "good"); clearStatus(6000);
  }
  async function doPrint() {
    const doc = buildDoc(); setStatus("Building the pattern…", "info");
    const res = await buildTiled(doc); if (!res) return;
    await printBytes(res.bytes, "pattern", { sheets: res.sheets, name: doc.name });
  }
  // Export the whole board as a single vector file (the exact geometry that prints).
  function doExport(format) {
    const doc = buildDoc();
    const text = G.exportBoard(doc, format);
    if (!text) { setStatus("Couldn't build the export — reload the page and try again.", "bad"); return; }
    const base = (doc.name || "pattern").replace(/\s+/g, "-");
    if (format === "dxf") downloadText(text, base + ".dxf", "application/dxf");
    else downloadText(text, base + ".svg", "image/svg+xml");
    setStatus(`Exported ${format.toUpperCase()}.`, "good"); clearStatus(4000);
  }

  // ── load ──────────────────────────────────────────────────────────────────
  async function loadDoc() {
    const ident = window.SEWING_EDIT || {};
    if (!ident.id) { const pp = G.defaultParams(); state.pieces = pp.pieces; state.gridMm = pp.gridMm; state.name = ""; return; }
    let p;
    try { const r = await fetch(api("/patterns/" + ident.id)); if (!r.ok) throw 0; p = await r.json(); }
    catch { setStatus("Couldn't load that pattern.", "bad"); state.pieces = G.defaultParams().pieces; return; }
    state.name = p.name || "";
    state.seams = [];
    if (p.kind === "freeform") {
      const params = p.params || {};
      state.pieces = G.normalizePieces(params); state.gridMm = params.gridMm || 5; state.id = ident.id;
      state.pieces.forEach((pc) => G.migrateNotches(pc));   // upgrade legacy {x,y} notches now so the single→double cycle works in-session
      state.seams = G.normalizeSeams(params.seams || [], state.pieces);
      state.body = G.normalizeBody(params.body);   // schema-3 wearer measurements (null for bags)
    } else if (p.kind === "rectangle") {
      state.pieces = [G.rectPiece(p.name || "Piece", p.params.widthMm, p.params.heightMm)];
      state.name = (p.name || "Pattern") + " copy"; state.id = null;
      setStatus("Editing a freeform copy — saving makes a new pattern.", "info"); clearStatus(6000);
    } else if (p.kind === "box") {
      const doc = PDF.boxyTotePattern(p.name, p.params);
      state.pieces = G.piecesFromDoc(doc);
      state.name = (p.name || "Bag") + " copy"; state.id = null;
      setStatus("Opened the tote as editable pieces — tap a piece to edit, then Save makes a new pattern.", "info"); clearStatus(7000);
    } else {
      state.pieces = G.defaultParams().pieces;
    }
    if (!state.pieces.length) state.pieces = G.defaultParams().pieces;
  }

  // ── init ────────────────────────────────────────────────────────────────────
  async function init() {
    svg = $("#canvas"); if (!svg) return;
    geoG = $("#layer-geo"); gridG = $("#grid"); pathsG = $("#paths");
    edgesG = $("#edges"); handlesG = $("#handles");
    nameInput = $("#ed-name"); readoutEl = $("#ed-readout");

    await loadDoc();
    if (state.pieces.some((p) => !p.layout)) G.packLayouts(state.pieces);   // give every piece a board position
    ensurePieceIds();                                                         // stable ids before any seam can reference them
    state.seams = G.normalizeSeams(state.seams, state.pieces);                // drop refs to pieces dropped on load
    state.active = Math.min(state.active, state.pieces.length - 1);
    geomCacheMap.clear();
    if (nameInput) {
      nameInput.value = state.name;
      nameInput.addEventListener("input", () => { state.name = nameInput.value; });
      nameInput.addEventListener("change", () => { state.name = nameInput.value; commit(); });
    }
    const unitSel = $("#ed-unit");
    if (unitSel) {
      try { const u = localStorage.getItem("sewing.unit"); if (u) state.unit = u; } catch (_) { /* private mode */ }
      unitSel.value = state.unit;
      unitSel.addEventListener("change", () => {
        state.unit = unitSel.value;
        try { localStorage.setItem("sewing.unit", state.unit); } catch (_) { /* private mode */ }
        setReadoutForSelection(); updateSnapChip(); render();
      });
    }

    resetHistory();
    ensureInitialFit(12);

    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onCancel);
    svg.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", () => scheduleRender());

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]"); if (!btn) return;
      switch (btn.dataset.action) {
        case "ed-undo": undo(); break;
        case "ed-redo": redo(); break;
        case "ed-snap": state.snapOn = !state.snapOn; updateSnapChip(); break;
        case "ed-garment": toggleGarment(); break;
        case "ed-select": setMode(null); break;
        case "ed-notch": toggleNotch(); break;
        case "ed-seam": toggleSew(); break;
        case "ed-curve": toggleCurve(); break;
        case "ed-dart": toggleDart(); break;
        case "ed-curve-type": cycleCurveType(); break;
        case "ed-curve-side": setCurveSide(btn.dataset.side); break;
        case "ed-del-curve": deleteCurve(); break;
        case "ed-dart-kind": setDartKind(btn.dataset.kind); break;
        case "ed-del-dart": deleteDart(); break;
        case "ed-select-seam": selectSeam(parseInt(btn.dataset.seam, 10)); break;
        case "ed-del-seam": deleteSeam(); break;
        case "ed-seam-angle": setSeamAngle(btn.dataset.angle); break;
        case "ed-seam-flip": setSeamFlip(); break;
        case "ed-delete": deleteSelected(); break;
        case "ed-add-place": addPlacement(); break;
        case "ed-del-place": deletePlacement(); break;
        case "ed-fit": fitAll(); render(); break;
        case "ed-arrange": autoArrange(); break;
        case "ed-save": save(); break;
        case "ed-download": doDownload(); break;
        case "ed-print": doPrint(); break;
        case "ed-export-svg": doExport("svg"); break;
        case "ed-export-dxf": doExport("dxf"); break;
        case "ed-add-sleeve": addSleeve(); break;
        case "ed-add-piece": addPiece(); break;
        case "ed-dup-piece": duplicatePiece(); break;
        case "ed-del-piece": deletePiece(); break;
        case "ed-select-piece": selectPiece(parseInt(btn.dataset.piece, 10)); break;
      }
    });

    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (state.selection.type === "placement") deletePlacement();
        else if (state.selection.type === "dart") deleteDart();
        else if (state.selection.type === "curve") deleteCurve();
        else deleteSelected();
      }
    });

    updateSnapChip();
    syncModeChips();
    updateMeasureChip();
  }
  function updateSnapChip() {
    const c = $("#ed-snap"); if (!c) return;
    c.classList.toggle("on", state.snapOn);
    c.textContent = state.snapOn ? "Snap " + fmtVal(state.gridMm) + " " + unitShort() : "Snap off";
  }
  function toggleNotch() {
    setMode("notchMode");
    if (state.notchMode) { setStatus("Notch mode: tap an edge to add a notch, tap a notch to remove it.", "info"); clearStatus(3500); }
  }
  function updateNotchChip() { const c = $("#ed-notch"); if (c) c.classList.toggle("on", state.notchMode); }

  document.addEventListener("DOMContentLoaded", init);
})();
