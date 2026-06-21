/* pattern-geom.js — pure geometry for the freeform editor (window.PatternGeom).
 *
 * NO DOM, NO third-party deps (steps 1–2) so it can be eval'd headless under
 * Node alongside pattern-pdf.js (see tools/tiling/verify-editor-geom.mjs). The
 * editor (editor.js) calls these for all math; the tiler (pattern-pdf.js) stays
 * untouched and simply consumes the document this module produces.
 *
 * Coordinate system, everywhere a "world" point appears: millimetres, bottom-
 * left origin, y-UP — identical to the pattern document the tiler reads. The
 * only y-flip in the whole app lives in worldToScreen/screenToWorld (the SVG
 * canvas is top-left, y-down). Step 3 will add curve flattening + Maker.js
 * seam-allowance offset here, behind these same signatures.
 */
(function () {
  "use strict";

  // ── small numeric helpers ──────────────────────────────────────────────────
  const round2 = (v) => Math.round(v * 100) / 100;        // 0.01 mm — kill float drift
  const round1 = (v) => Math.round(v * 10) / 10;          // 0.1 mm — clean unsnapped points
  // accept a point as [x,y] or {x,y}; return {x,y}
  const P = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p);

  // ── camera transforms (the single source of truth for the y-flip) ──────────
  // cam = { k: px-per-mm, tx, ty } where (tx,ty) is the screen position of world (0,0).
  function worldToScreen(x, y, cam) {
    return { sx: cam.tx + cam.k * x, sy: cam.ty - cam.k * y };
  }
  function screenToWorld(sx, sy, cam) {
    return { x: (sx - cam.tx) / cam.k, y: (cam.ty - sy) / cam.k };
  }
  // The SVG geometry-group transform matching the camera: matrix(k,0,0,-k,tx,ty).
  function cameraMatrix(cam) {
    return `matrix(${cam.k},0,0,${-cam.k},${cam.tx},${cam.ty})`;
  }

  // ── snapping ───────────────────────────────────────────────────────────────
  // snap a scalar to the grid (gridMm); falsy/zero grid → just clean to 0.1 mm.
  function snap(v, gridMm) {
    if (!gridMm || gridMm <= 0) return round1(v);
    return round2(Math.round(v / gridMm) * gridMm);
  }
  function snapPoint(p, gridMm) {
    p = P(p);
    return { x: snap(p.x, gridMm), y: snap(p.y, gridMm) };
  }

  // ── distances / projection (used by screen-space hit-testing) ──────────────
  function edgeLength(a, b) {
    a = P(a); b = P(b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  // perpendicular point + parameter t∈[0,1] of p projected onto segment a→b.
  function projectPointOnSegment(p, a, b) {
    p = P(p); a = P(a); b = P(b);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return { x: a.x + t * dx, y: a.y + t * dy, t };
  }
  function pointToSegmentDist(p, a, b) {
    const q = projectPointOnSegment(p, a, b);
    p = P(p);
    return Math.hypot(p.x - q.x, p.y - q.y);
  }

  // ── bounding box over points ([x,y] or {x,y}) or nodes ─────────────────────
  function bbox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const raw of points) {
      const p = P(raw);
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX)) { minX = minY = maxX = maxY = 0; }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  // ── node ⇄ polyline ────────────────────────────────────────────────────────
  // nodes: [{x,y,radius?}] (one closed polygon). points: [[x,y],...] (doc format).
  function nodesToPoints(nodes, closed) {
    const pts = nodes.map((n) => [round2(n.x), round2(n.y)]);
    if (closed !== false && pts.length > 1) pts.push([pts[0][0], pts[0][1]]);
    return pts;
  }
  // Build the document's `paths` from nodes. Step 2 = cut line only; the seam
  // line (offset by seamMm) and corner fillets (radius) arrive with Maker.js in
  // step 3 — seamMm/radius are carried through but not yet rendered.
  function nodesToPaths(nodes, opts) {
    opts = opts || {};
    const closed = opts.closed !== false;
    return [{ kind: "cut", points: nodesToPoints(nodes, closed) }];
  }
  // Insert a vertex after edge `edgeIndex` (edge i = node i → node i+1).
  function insertVertexOnEdge(nodes, edgeIndex, point) {
    point = P(point);
    const out = nodes.slice();
    out.splice(edgeIndex + 1, 0, { x: round2(point.x), y: round2(point.y), radius: 0 });
    return out;
  }
  // A closed polyline (last point may duplicate the first) → editable nodes.
  function polylineToNodes(points) {
    const pts = points.slice();
    if (pts.length > 1) {
      const a = P(pts[0]), b = P(pts[pts.length - 1]);
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) pts.pop();
    }
    return pts.map((p) => { p = P(p); return { x: round2(p.x), y: round2(p.y), radius: 0 }; });
  }

  // ── document assembly ──────────────────────────────────────────────────────
  // Shift all geometry so min corner sits at (0,0) — the bottom-left-origin
  // invariant the tiler needs — and set widthMm/heightMm from the bbox. Shifts
  // paths, labels AND nodes by the same offset so they never diverge.
  // NOTE: only called at export/save time, never during live editing (so the
  // user's coordinates don't jump while dragging near the origin).
  function normalizeDoc(doc) {
    const pts = [];
    for (const p of doc.paths || []) for (const xy of p.points) pts.push(xy);
    for (const n of doc.nodes || []) pts.push([n.x, n.y]);
    const bb = bbox(pts);
    const dx = -bb.minX, dy = -bb.minY;
    const out = Object.assign({}, doc, {
      paths: (doc.paths || []).map((p) =>
        Object.assign({}, p, { points: p.points.map(([x, y]) => [round2(x + dx), round2(y + dy)]) })),
      labels: (doc.labels || []).map((l) =>
        Object.assign({}, l, { xMm: round2(l.xMm + dx), yMm: round2(l.yMm + dy) })),
      widthMm: Math.max(1, Math.ceil(bb.w)),
      heightMm: Math.max(1, Math.ceil(bb.h)),
    });
    if (doc.nodes) out.nodes = doc.nodes.map((n) =>
      Object.assign({}, n, { x: round2(n.x + dx), y: round2(n.y + dy) }));
    return out;
  }

  // ── pieces (a freeform document is a list of independent pieces) ───────────
  // A piece = { name, count, seamMm, closed, nodes:[{x,y,radius}] } in its OWN
  // local mm coordinates. freeformToDoc packs them into one layout the tiler
  // splits across sheets — so "a whole bag" = several pieces in one document.
  function rectPiece(name, w, h) {
    return { name: name || "Piece", count: 1, seamMm: 0, cornerRadius: 0, closed: true,
      nodes: [{ x: 0, y: 0, radius: 0 }, { x: w, y: 0, radius: 0 }, { x: w, y: h, radius: 0 }, { x: 0, y: h, radius: 0 }],
      notches: [], placements: [], layout: null };
  }
  function clonePiece(p, i) {
    return {
      id: p.id || ("p" + (i + 1)),
      name: p.name || ("Piece " + (i + 1)),
      count: Math.max(1, Math.round(p.count || 1)),
      seamMm: Math.max(0, p.seamMm || 0),
      cornerRadius: Math.max(0, p.cornerRadius || 0),
      closed: p.closed !== false,
      nodes: (p.nodes || []).map((n) => ({ x: n.x, y: n.y, radius: n.radius || 0 })),
      // notches: a point that snaps to the nearest edge (robust to vertex edits).
      notches: (p.notches || []).map((nt) => ({ x: nt.x, y: nt.y })),
      // placements: a guide rectangle (e.g. where a pocket attaches) + a label.
      placements: (p.placements || []).map((pl) => ({
        x: pl.x, y: pl.y, w: Math.max(1, pl.w), h: Math.max(1, pl.h), label: pl.label || "Pocket" })),
      // layout: this piece's position on the shared board (mm); null → auto-arranged.
      layout: p.layout ? { x: p.layout.x, y: p.layout.y } : null,
    };
  }
  // Accept the multi-piece shape, OR a legacy single-shape (schema 1 `nodes`),
  // OR nothing — always return a non-empty pieces array.
  function normalizePieces(params) {
    if (params.pieces && params.pieces.length) return params.pieces.map(clonePiece);
    if (params.nodes && params.nodes.length)
      return [clonePiece({ name: params.name || "Piece 1", count: 1, seamMm: params.seamMm || 0, closed: params.closed !== false, nodes: params.nodes }, 0)];
    return [clonePiece(rectPiece("Piece 1", 300, 400), 0)];
  }
  function pieceLabelLines(p, w, h) {
    const lines = [`${p.name}${p.count > 1 ? " — cut " + p.count : ""}`, `${Math.round(w)} × ${Math.round(h)} mm`];
    if (p.seamMm > 0) lines.push(`+ ${Math.round(p.seamMm)} mm seam allowance`);
    return lines;
  }

  // ── corner rounding + seam-allowance offset (Maker.js, with a fallback) ─────
  // Maker.js (window.makerjs, vendored only on /edit) does the polygon offset and
  // the corner fillets — both flattened to polylines here so the proven, line-only
  // tiler stays untouched. DESIGN.md: do NOT hand-roll polygon offsetting.
  const maker = () => (typeof window !== "undefined" && window.makerjs) || null;
  // chord-tolerance → max arc-facet length (mm) for a given fillet radius.
  function facetFor(r) { return r > 0 ? Math.max(0.6, Math.min(4, 2 * Math.sqrt(0.4 * r))) : 2.5; }
  function modelFromNodes(mk, nodes) {
    const m = { paths: {} };
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], b = nodes[(i + 1) % nodes.length];
      m.paths["e" + i] = new mk.paths.Line([a.x, a.y], [b.x, b.y]);
    }
    return m;
  }
  // a Maker.js model → a CLOSED polyline ([[x,y]…], last == first), or null.
  function flattenModel(mk, model, facet) {
    const ch = mk.model.findChains(model)[0];
    if (!ch) return null;
    const kp = mk.chain.toKeyPoints(ch, facet);
    if (!kp || kp.length < 3) return null;
    const pts = kp.map((p) => [round2(p[0]), round2(p[1])]);
    pts.push([pts[0][0], pts[0][1]]);
    return pts;
  }
  // A piece → { cut, seam } polylines. cut = the (optionally rounded) outline;
  // seam = the stitch line inset by seamMm (null if no SA, or if the offset
  // failed — e.g. SA too large for a tight feature). No Maker.js / no radius /
  // no SA → straight cut line (unchanged, dependency-free).
  function pieceGeom(piece) {
    const r = Math.max(0, piece.cornerRadius || 0);
    const sa = Math.max(0, piece.seamMm || 0);
    const mk = maker();
    if (!mk || (r === 0 && sa === 0)) {
      return { cut: nodesToPoints(piece.nodes, piece.closed), seam: null };
    }
    const facet = facetFor(r);
    let model = modelFromNodes(mk, piece.nodes);
    if (r > 0) {
      try {
        const ch = mk.model.findChains(model)[0];
        const fil = ch ? mk.chain.fillet(ch, r) : null;
        if (fil) model = { models: { base: model, fillets: fil } };
        else model = modelFromNodes(mk, piece.nodes);
      } catch (_) { model = modelFromNodes(mk, piece.nodes); }
    }
    let cut = flattenModel(mk, model, facet) || nodesToPoints(piece.nodes, piece.closed);
    let seam = null;
    if (sa > 0) {
      try { seam = flattenModel(mk, mk.model.outline(model, sa, 0, true), facet); }
      catch (_) { seam = null; }
    }
    return { cut, seam };
  }

  // ── notches + placement guides (per-piece marks) ───────────────────────────
  const rectPts = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  // the edge nearest to a point, plus the projection of the point onto it.
  function nearestEdge(nodes, pt) {
    let best = -1, bestD = Infinity, proj = null;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], b = nodes[(i + 1) % nodes.length];
      const pr = projectPointOnSegment(pt, a, b);
      const d = Math.hypot(pt.x - pr.x, pt.y - pr.y);
      if (d < bestD) { bestD = d; best = i; proj = pr; }
    }
    return { edge: best, proj, dist: bestD };
  }
  // a notch point → a short tick straddling the nearest edge, perpendicular to it.
  function notchMark(nodes, pt, len) {
    const n = nodes.length; if (n < 2) return null;
    const ne = nearestEdge(nodes, P(pt)); const a = nodes[ne.edge], b = nodes[(ne.edge + 1) % n];
    let dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); if (L < 1e-6) return null; dx /= L; dy /= L;
    const nx = -dy, ny = dx, h = (len || 7) / 2, px = ne.proj.x, py = ne.proj.y;
    return [[round2(px - nx * h), round2(py - ny * h)], [round2(px + nx * h), round2(py + ny * h)]];
  }
  // per-piece extra paths/labels (in LOCAL coords): notch ticks + placement rects.
  function pieceExtras(piece) {
    const paths = [], labels = [];
    for (const nt of (piece.notches || [])) {
      const m = notchMark(piece.nodes, nt); if (m) paths.push({ kind: "cut", points: m });
    }
    for (const pl of (piece.placements || [])) {
      paths.push({ kind: "seam", points: rectPts(pl.x, pl.y, pl.x + pl.w, pl.y + pl.h) });
      labels.push({ xMm: pl.x + pl.w / 2, yMm: pl.y + pl.h / 2, size: 9, lines: [pl.label || "Pocket"] });
    }
    return { paths, labels };
  }
  // Extract editable pieces from any generated doc (e.g. a boxy tote) by pairing
  // its `cut` paths with the labels in the same order — the bridge that lets a
  // template be opened and customised as freeform pieces.
  function piecesFromDoc(doc) {
    const cuts = (doc.paths || []).filter((p) => p.kind === "cut");
    return cuts.map((c, i) => {
      const lab = doc.labels && doc.labels[i];
      let name = "Piece " + (i + 1), count = 1;
      if (lab && lab.lines && lab.lines[0]) {
        name = lab.lines[0].split(" — ")[0].trim() || name;
        const m = /cut\s+(\d+)/i.exec(lab.lines[0]); if (m) count = parseInt(m[1], 10);
      }
      // Route through clonePiece so the piece is fully-formed (notches/placements/
      // cornerRadius/layout defaults) — the editor assumes those fields exist.
      return clonePiece({ name, count, seamMm: 0, closed: true, nodes: polylineToNodes(c.points) }, i);
    });
  }

  // params (the editable freeform geometry) → a complete, tiler-ready document.
  // Shelf-packs every piece into one layout (next-fit, like boxyTote), capping
  // the row width to the widest piece so a long strap gets its own row. The
  // output carries BOTH the tiler `paths`/`labels` AND the editable `pieces`, so
  // it round-trips on reload (stored whole in params_json).
  // assign each piece a board position (layout) via shelf-pack (next-fit, width-
  // capped to the widest piece). Sets piece.layout so local + layout lands the
  // piece's cut bbox at its shelf cell. Mutates + returns pieces.
  function packLayouts(pieces) {
    const gap = 12;
    const locals = pieces.map((p) => ({ p, bb: bbox(pieceGeom(p).cut) }));
    const capW = Math.max(...locals.map((l) => l.bb.w)) + 2 * gap;
    let x = gap, yTop = gap, shelfH = 0;
    const placed = [];
    for (const l of locals) {
      if (x + l.bb.w + gap > capW && x > gap) { yTop += shelfH + gap; x = gap; shelfH = 0; }
      placed.push({ l, x, yTop }); x += l.bb.w + gap; shelfH = Math.max(shelfH, l.bb.h);
    }
    const boundH = yTop + shelfH + gap;
    for (const pc of placed) {
      const gy1 = boundH - pc.yTop, gy0 = gy1 - pc.l.bb.h, gx0 = pc.x;
      pc.l.p.layout = { x: round2(gx0 - pc.l.bb.minX), y: round2(gy0 - pc.l.bb.minY) };
    }
    return pieces;
  }

  // params → tiler-ready doc. Each piece is placed at its stored `layout` on a
  // shared board (WYSIWYG: what the editor shows is what prints); pieces missing
  // a layout are auto-packed first. The board is normalized to a (0,0) origin and
  // each output piece's layout is shifted to match, so the stored doc round-trips.
  function freeformToDoc(params) {
    params = params || {};
    const pieces = normalizePieces(params);
    if (pieces.some((p) => !p.layout)) packLayouts(pieces);
    const placed = pieces.map((p) => {
      const g = pieceGeom(p), ex = pieceExtras(p), L = p.layout || { x: 0, y: 0 };
      const off = (pts) => pts.map(([px, py]) => [px + L.x, py + L.y]);
      const cut = off(g.cut), seam = g.seam ? off(g.seam) : null;
      const exPaths = ex.paths.map((e) => ({ kind: e.kind, points: off(e.points) }));
      const exLabels = ex.labels.map((e) => ({ xMm: e.xMm + L.x, yMm: e.yMm + L.y, size: e.size, lines: e.lines }));
      return { p, L, cut, seam, exPaths, exLabels, bb: bbox(cut) };
    });
    const allPts = [];
    for (const pc of placed) {
      for (const pt of pc.cut) allPts.push(pt);
      if (pc.seam) for (const pt of pc.seam) allPts.push(pt);
      for (const e of pc.exPaths) for (const pt of e.points) allPts.push(pt);
    }
    const board = bbox(allPts), dx = -board.minX, dy = -board.minY;
    const shift = (pts) => pts.map(([px, py]) => [round2(px + dx), round2(py + dy)]);
    const paths = [], labels = [];
    for (const pc of placed) {
      paths.push({ kind: "cut", points: shift(pc.cut) });
      if (pc.seam) paths.push({ kind: "seam", points: shift(pc.seam) });
      for (const e of pc.exPaths) paths.push({ kind: e.kind, points: shift(e.points) });
      for (const e of pc.exLabels) labels.push({ xMm: round2(e.xMm + dx), yMm: round2(e.yMm + dy), size: e.size, lines: e.lines });
      labels.push({ xMm: round2(pc.bb.minX + pc.bb.w / 2 + dx), yMm: round2(pc.bb.minY + pc.bb.h / 2 + dy), size: 10, lines: pieceLabelLines(pc.p, pc.bb.w, pc.bb.h) });
      pc.p.layout = { x: round2(pc.L.x + dx), y: round2(pc.L.y + dy) };
    }
    return {
      name: params.name || "Untitled", kind: "freeform", schema: 2, pieces, paths, labels,
      gridMm: params.gridMm || 5,
      widthMm: Math.max(1, Math.ceil(board.w)), heightMm: Math.max(1, Math.ceil(board.h)),
    };
  }

  // a sensible blank document for /edit (one 300×400 mm rectangle piece).
  function defaultParams() {
    return { schema: 2, gridMm: 5, pieces: [rectPiece("Piece 1", 300, 400)] };
  }

  window.PatternGeom = {
    round1, round2,
    worldToScreen, screenToWorld, cameraMatrix,
    snap, snapPoint,
    edgeLength, projectPointOnSegment, pointToSegmentDist,
    bbox,
    nodesToPoints, nodesToPaths, insertVertexOnEdge, polylineToNodes,
    rectPiece, normalizePieces, piecesFromDoc, pieceGeom, nearestEdge, notchMark,
    packLayouts, normalizeDoc, freeformToDoc, defaultParams,
  };
})();
