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
  const SEAMC = "#8a8f98", DIM = "#b7b3aa";
  const FILL = "rgba(224,101,58,0.06)";
  const HIT_VERTEX = 22, HIT_EDGE = 14, K_MIN = 0.05, K_MAX = 40, MOVE_TOL = 4;

  let svg, geoG, gridG, pathsG, edgesG, handlesG, nameInput, readoutEl;
  let rafPending = false;

  const state = {
    id: null, name: "", kind: "freeform",
    pieces: [], active: 0,                 // each {id,name,count,seamMm,cornerRadius,closed,nodes,notches,placements,layout}
    snapOn: true, notchMode: false, unit: "mm", gridMm: 5,
    cam: { k: 1, tx: 0, ty: 0 },
    selection: { type: "none", index: -1 },   // vertex | edge | placement | none
    history: [], hindex: -1,
  };
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
  const toMm = (v) => (state.unit === "in" ? v * 25.4 : v);
  const unitLabel = () => (state.unit === "in" ? "inches" : "mm");
  const unitShort = () => (state.unit === "in" ? "in" : "mm");
  function fmtVal(mm) {
    if (state.unit === "in") return (mm / 25.4).toFixed(2);
    const r = Math.round(mm * 10) / 10; return String(Number.isInteger(r) ? r : r.toFixed(1));
  }
  const fmtLen = (mm) => fmtVal(mm) + (state.unit === "in" ? '"' : " mm");

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

  // ── render ──────────────────────────────────────────────────────────────────
  function scheduleRender() {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }
  function render() { applyCamera(); drawGrid(); drawPaths(); drawOverlay(); renderPieceList(); updateNumericPanel(); updateButtons(); }
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
    const key = JSON.stringify({ n: p.nodes, r: p.cornerRadius || 0, s: p.seamMm || 0, c: p.closed });
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
      const op = act ? 1 : 0.45;
      if (g.seam && g.seam.length)
        s += `<path d="${polyD(off(g.seam))}" fill="none" stroke="${SEAMC}" stroke-width="1" stroke-dasharray="5 3" opacity="${op}" vector-effect="non-scaling-stroke"/>`;
      if (g.cut && g.cut.length)
        s += `<path d="${polyD(off(g.cut))}" fill="${act ? FILL : "none"}" stroke="${act ? INK : DIM}" stroke-width="${act ? 2 : 1.3}" opacity="${op}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      p.placements.forEach((pl, idx) => {
        const sel = act && state.selection.type === "placement" && state.selection.index === idx;
        const pts = `${pl.x + L.x},${pl.y + L.y} ${pl.x + pl.w + L.x},${pl.y + L.y} ${pl.x + pl.w + L.x},${pl.y + pl.h + L.y} ${pl.x + L.x},${pl.y + pl.h + L.y}`;
        s += `<polygon points="${pts}" fill="none" stroke="${sel ? SEL : SEAMC}" stroke-width="${sel ? 2 : 1.3}" opacity="${op}" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`;
      });
      for (const nt of p.notches) {
        const m = G.notchMark(p.nodes, nt);
        if (m) s += `<line x1="${m[0][0] + L.x}" y1="${m[0][1] + L.y}" x2="${m[1][0] + L.x}" y2="${m[1][1] + L.y}" stroke="${act ? INK : DIM}" stroke-width="1.6" opacity="${op}" vector-effect="non-scaling-stroke"/>`;
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
      ap.placements.forEach((pl, i) => {
        const c = W2S(aB({ x: pl.x + pl.w / 2, y: pl.y + pl.h / 2 }));
        const sel = state.selection.type === "placement" && state.selection.index === i;
        eSvg += labelTag(c.sx, c.sy + 4, pl.label || "Pocket", sel ? SEL : SEAMC);
      });
      for (let i = 0; i < n; i++) {
        const s = W2S(aB(ns[i]));
        const isSel = state.selection.type === "vertex" && state.selection.index === i;
        if (isSel) hSvg += `<circle cx="${s.sx}" cy="${s.sy}" r="11" fill="none" stroke="${SEL}" stroke-width="2"/>`;
        hSvg += `<circle cx="${s.sx}" cy="${s.sy}" r="6.5" fill="${ACCENT}" stroke="#fff" stroke-width="1.6"/>`;
      }
    }
    edgesG.innerHTML = eSvg;
    handlesG.innerHTML = hSvg;
  }

  // ── pieces panel ─────────────────────────────────────────────────────────────
  function renderPieceList() {
    const list = $("#ed-pieces");
    if (list) {
      list.innerHTML = state.pieces.map((p, i) => {
        const bb = G.bbox(G.nodesToPoints(p.nodes, p.closed));
        return `<button class="piece-row${i === state.active ? " on" : ""}" data-action="ed-select-piece" data-piece="${i}">`
          + `<span class="piece-row__name">${escapeHtml(p.name)}</span>`
          + `<span class="piece-row__meta">${Math.round(bb.w)}×${Math.round(bb.h)} mm${p.count > 1 ? " · cut " + p.count : ""}</span>`
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
  }
  function addPiece() {
    const p = G.rectPiece("Piece " + (state.pieces.length + 1), 150, 200);
    placeToRight(p);
    state.pieces.push(p); state.active = state.pieces.length - 1; select("none", -1); commit(); fitPiece(state.active); render();
  }
  function duplicatePiece() {
    const ap = activePiece(); if (!ap) return;
    const copy = JSON.parse(JSON.stringify(ap)); copy.name = ap.name + " copy"; delete copy.id;
    placeToRight(copy);
    state.pieces.splice(state.active + 1, 0, copy); state.active += 1; select("none", -1); commit(); fitPiece(state.active); render();
  }
  function deletePiece() {
    if (state.pieces.length <= 1) { setStatus("Keep at least one piece.", "warn"); clearStatus(3000); return; }
    state.pieces.splice(state.active, 1); state.active = Math.max(0, state.active - 1); select("none", -1); commit(); fitPiece(state.active); render();
  }
  function selectPiece(i) {
    if (i < 0 || i >= state.pieces.length) return;
    state.active = i; select("none", -1); fitPiece(i); render();
  }
  function autoArrange() { G.packLayouts(state.pieces); commit(); fitAll(); render(); }

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
        + `</div>`;
      wireNumeric(["#ed-x", "#ed-y"]);
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
    } else {
      box.innerHTML = `<div class="empty">Tap a piece to edit it · drag a piece to move it · tap a corner or edge to adjust.</div>`;
    }
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
    const max = !ap ? 0 : s.type === "vertex" || s.type === "edge" ? ap.nodes.length : s.type === "placement" ? ap.placements.length : 0;
    if (s.type !== "none" && (s.index < 0 || s.index >= max)) state.selection = { type: "none", index: -1 };
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
    } else setReadout("");
  }

  // ── history (undo/redo) ──────────────────────────────────────────────────────
  const editSnapshot = () => JSON.stringify({ pieces: state.pieces, active: state.active, name: state.name });
  function resetHistory() { state.history = [editSnapshot()]; state.hindex = 0; }
  function commit() {
    state.history = state.history.slice(0, state.hindex + 1);
    state.history.push(editSnapshot()); state.hindex = state.history.length - 1;
    if (state.history.length > 100) { state.history.shift(); state.hindex--; }
  }
  function restore(snap) {
    const o = JSON.parse(snap);
    geomCacheMap.clear();
    state.pieces = (o.pieces || []).map((p, i) => ({
      id: p.id || ("p" + (i + 1)), name: p.name || ("Piece " + (i + 1)),
      count: Math.max(1, Math.round(p.count || 1)), seamMm: p.seamMm || 0, cornerRadius: p.cornerRadius || 0, closed: p.closed !== false,
      nodes: (p.nodes || []).map((n) => ({ x: n.x, y: n.y, radius: n.radius || 0 })),
      notches: (p.notches || []).map((nt) => ({ x: nt.x, y: nt.y })),
      placements: (p.placements || []).map((pl) => ({ x: pl.x, y: pl.y, w: pl.w, h: pl.h, label: pl.label || "Pocket" })),
      layout: p.layout ? { x: p.layout.x, y: p.layout.y } : null,
    }));
    if (!state.pieces.length) state.pieces = [G.rectPiece("Piece 1", 300, 400)];
    state.active = Math.min(o.active || 0, state.pieces.length - 1);
    state.name = o.name || ""; if (nameInput) nameInput.value = state.name;
    clampSelection();
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
  function hitNotch(p) {
    const ap = activePiece(); if (!ap) return -1;
    const L = activeLayout(); let best = -1, bestD = 18;
    for (let i = 0; i < ap.notches.length; i++) {
      const m = G.notchMark(ap.nodes, ap.notches[i]); if (!m) continue;
      const s = W2S({ x: (m[0][0] + m[1][0]) / 2 + L.x, y: (m[0][1] + m[1][1]) / 2 + L.y });
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

  function handleNotchTap(p) {
    const ap = activePiece(); if (!ap) return;
    const ri = hitNotch(p);
    if (ri >= 0) { ap.notches.splice(ri, 1); commit(); setStatus("Notch removed.", "info"); clearStatus(2000); return; }
    const L = activeLayout(), wl = S2W(p.sx, p.sy);
    const ne = G.nearestEdge(ap.nodes, { x: wl.x - L.x, y: wl.y - L.y });
    const pr = G.worldToScreen(ne.proj.x + L.x, ne.proj.y + L.y, state.cam);
    if (Math.hypot(p.sx - pr.sx, p.sy - pr.sy) > 28) { setStatus("Tap on an edge to add a notch.", "warn"); clearStatus(2500); return; }
    ap.notches.push({ x: G.round2(ne.proj.x), y: G.round2(ne.proj.y) });
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
    activePiece().nodes = G.insertVertexOnEdge(ns, ei, { x: G.round2(w.x), y: G.round2(w.y) });
    commit(); select("vertex", ei + 1);
  }
  function deleteSelected() {
    if (!canEdit()) return;
    if (state.selection.type !== "vertex") { setStatus("Select a corner first, then Delete.", "warn"); clearStatus(3000); return; }
    if (nodes().length <= 3) { setStatus("A shape needs at least 3 corners.", "warn"); clearStatus(3000); return; }
    nodes().splice(state.selection.index, 1);
    commit(); select("none", -1); scheduleRender();
  }
  // edge-insert / notch / deselect when a tap lands on (or near) the active piece
  function resolveActiveTap(p) {
    if (!canEdit()) { select("none", -1); return; }
    if (state.notchMode) { handleNotchTap(p); return; }
    const ei = hitEdge(p);
    if (ei >= 0) { insertOnEdge(ei, p); return; }
    select("none", -1);
  }

  // ── pointer interaction ──────────────────────────────────────────────────────
  const pointers = new Map();
  let mode = "idle", dragIndex = -1, dragMoved = false, panStart = null, pinchStart = null;
  let placeIndex = -1, placeGrab = null, pieceMove = null;

  function localPoint(e) { const r = svg.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }

  function onDown(e) {
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    const p = localPoint(e); pointers.set(e.pointerId, p);
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;
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
    if (mode === "maybePan") {
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
    if (mode === "dragPiece") { if (dragMoved) commit(); mode = "idle"; scheduleRender(); return; }
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
    if ((mode === "drag" || mode === "dragPlace" || mode === "dragPiece") && dragMoved) restore(state.history[state.hindex]);
    mode = "idle"; dragIndex = -1; placeIndex = -1; pieceMove = null; scheduleRender();
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
    return G.freeformToDoc({ pieces: state.pieces, name: (nameInput.value || "Untitled").trim() || "Untitled", gridMm: state.gridMm });
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

  // ── load ──────────────────────────────────────────────────────────────────
  async function loadDoc() {
    const ident = window.SEWING_EDIT || {};
    if (!ident.id) { const pp = G.defaultParams(); state.pieces = pp.pieces; state.gridMm = pp.gridMm; state.name = ""; return; }
    let p;
    try { const r = await fetch(api("/patterns/" + ident.id)); if (!r.ok) throw 0; p = await r.json(); }
    catch { setStatus("Couldn't load that pattern.", "bad"); state.pieces = G.defaultParams().pieces; return; }
    state.name = p.name || "";
    if (p.kind === "freeform") {
      const params = p.params || {};
      state.pieces = G.normalizePieces(params); state.gridMm = params.gridMm || 5; state.id = ident.id;
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
    state.active = Math.min(state.active, state.pieces.length - 1);
    geomCacheMap.clear();
    if (nameInput) {
      nameInput.value = state.name;
      nameInput.addEventListener("input", () => { state.name = nameInput.value; });
      nameInput.addEventListener("change", () => { state.name = nameInput.value; commit(); });
    }
    const unitSel = $("#ed-unit");
    if (unitSel) unitSel.addEventListener("change", () => { state.unit = unitSel.value; setReadoutForSelection(); render(); });

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
        case "ed-notch": toggleNotch(); break;
        case "ed-delete": deleteSelected(); break;
        case "ed-add-place": addPlacement(); break;
        case "ed-del-place": deletePlacement(); break;
        case "ed-fit": fitAll(); render(); break;
        case "ed-arrange": autoArrange(); break;
        case "ed-save": save(); break;
        case "ed-download": doDownload(); break;
        case "ed-print": doPrint(); break;
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
        if (state.selection.type === "placement") deletePlacement(); else deleteSelected();
      }
    });

    updateSnapChip();
    updateNotchChip();
  }
  function updateSnapChip() {
    const c = $("#ed-snap"); if (!c) return;
    c.classList.toggle("on", state.snapOn);
    c.textContent = state.snapOn ? "Snap " + state.gridMm + " mm" : "Snap off";
  }
  function toggleNotch() {
    state.notchMode = !state.notchMode; updateNotchChip();
    if (state.notchMode) { setStatus("Notch mode: tap an edge to add a notch, tap a notch to remove it.", "info"); clearStatus(3500); }
  }
  function updateNotchChip() { const c = $("#ed-notch"); if (c) c.classList.toggle("on", state.notchMode); }

  document.addEventListener("DOMContentLoaded", init);
})();
