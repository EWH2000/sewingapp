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
  // ── schema-3 garment-authoring helpers (additive; absent in schema ≤2 docs) ────
  // edges: a sparse map keyed by the STRING start-node index of a curved boundary edge.
  // Control points live in the edge-local frame (chord = X in [0,1], left-normal = Y in
  // units of the chord length) so the curve is invariant to the shelf-packer + scale.
  // quad = 1 cp [u,v]; cubic = 2 cps [u1,v1,u2,v2]; arc = [u,v] (apex, lowered as quad v1).
  function cloneEdges(edges, nNodes) {
    if (!edges || typeof edges !== "object") return {};
    const out = {};
    for (const k of Object.keys(edges)) {
      const i = parseInt(k, 10);
      if (!Number.isInteger(i) || i < 0 || i >= nNodes) continue;
      const e = edges[k]; const c = e && e.curve;
      if (!c || !Array.isArray(c.cp)) continue;
      const type = (c.type === "cubic" || c.type === "arc") ? c.type : "quad";
      const need = type === "cubic" ? 4 : 2;
      if (c.cp.length < need) continue;
      out[String(i)] = { curve: { type, cp: c.cp.slice(0, need).map((v) => +v || 0) } };
    }
    return out;
  }
  // a notch is either the upgraded {edge,t,type} (stable) or the legacy {x,y} (migrated on
  // save). clonePiece keeps whichever shape it's given so a load never loses data.
  function cloneNotch(nt) {
    if (nt && Number.isInteger(nt.edge))
      return { edge: nt.edge, t: Math.max(0, Math.min(1, +nt.t || 0)), type: nt.type === "double" ? "double" : "single" };
    return { x: nt.x, y: nt.y };   // legacy
  }
  function clonePiece(p, i) {
    const nodes = (p.nodes || []).map((n) => {
      const o = { x: n.x, y: n.y, radius: n.radius || 0 };
      if (n.saMm > 0) o.saMm = n.saMm;   // optional per-node seam-allowance override (variable SA)
      return o;
    });
    const out = {
      id: p.id || ("p" + (i + 1)),
      name: p.name || ("Piece " + (i + 1)),
      count: Math.max(1, Math.round(p.count || 1)),
      seamMm: Math.max(0, p.seamMm || 0),
      cornerRadius: Math.max(0, p.cornerRadius || 0),
      closed: p.closed !== false,
      // role: 3D-preview hint — "strap" renders as an arched handle, "panel" forces a
      // folded face, null = auto-detect (name/shape). Additive; absent in schema ≤2 docs.
      role: (p.role === "strap" || p.role === "panel") ? p.role : null,
      nodes,
      // notches: upgraded {edge,t,type} (or legacy {x,y}, migrated on save).
      notches: (p.notches || []).map(cloneNotch),
      // placements: a guide rectangle (e.g. where a pocket attaches) + a label.
      placements: (p.placements || []).map((pl) => ({
        x: pl.x, y: pl.y, w: Math.max(1, pl.w), h: Math.max(1, pl.h), label: pl.label || "Pocket" })),
      // layout: this piece's position on the shared board (mm); null → auto-arranged.
      layout: p.layout ? { x: p.layout.x, y: p.layout.y } : null,
    };
    // schema-3 garment authoring — only attach when present (keeps schema-2 docs byte-clean).
    const edges = cloneEdges(p.edges, nodes.length);
    if (Object.keys(edges).length) out.edges = edges;
    const darts = (p.darts || []).map((d, di) => ({
      id: d.id || ("d" + (di + 1)),
      edge: d.edge | 0,
      center: Math.max(0, Math.min(1, d.center == null ? 0.5 : +d.center)),
      width: Math.max(1, +d.width || 20),
      depth: Math.max(1, +d.depth || 60),
      kind: d.kind === "slash" ? "slash" : "wedge",
    })).filter((d) => d.edge >= 0 && d.edge < nodes.length);
    if (darts.length) out.darts = darts;
    if (p.place3d && typeof p.place3d === "object")
      out.place3d = { role: p.place3d.role || null, wrap: p.place3d.wrap || null };
    return out;
  }
  // Accept the multi-piece shape, OR a legacy single-shape (schema 1 `nodes`),
  // OR nothing — always return a non-empty pieces array. Piece ids are stable + UNIQUE
  // (existing ids preserved; missing ones get the next free "pN") so a seam's EdgeRef can't
  // silently retarget when pieces are added/removed/reordered.
  function normalizePieces(params) {
    if (params.pieces && params.pieces.length) {
      const used = new Set(params.pieces.map((p) => p.id).filter(Boolean));
      let c = 1; const freshId = () => { let id; do { id = "p" + (c++); } while (used.has(id)); used.add(id); return id; };
      return params.pieces.map((p, i) => clonePiece(p.id ? p : Object.assign({}, p, { id: freshId() }), i));
    }
    if (params.nodes && params.nodes.length)
      return [clonePiece({ name: params.name || "Piece 1", count: 1, seamMm: params.seamMm || 0, closed: params.closed !== false, nodes: params.nodes }, 0)];
    return [clonePiece(rectPiece("Piece 1", 300, 400), 0)];
  }
  // Seam graph (schema 3): a top-level list of which authored node-edge of which piece is
  // sewn to which. EdgeRef = { piece:<id>, edge:i } where edge i = the boundary edge leaving
  // node i (segment node[i]->node[i+1], mod the closed loop) — stable across node moves,
  // radius/seam changes, and the shelf-packer. Drop any seam whose ref points at a missing
  // piece or an out-of-range edge (e.g. after a piece/edge was deleted).
  function normalizeSeams(seams, pieces) {
    if (!Array.isArray(seams)) return [];
    const byId = {}; (pieces || []).forEach((p) => { byId[p.id] = p; });
    const okRef = (r) => r && byId[r.piece] && Number.isInteger(r.edge) && r.edge >= 0 && r.edge < byId[r.piece].nodes.length;
    const used = new Set(seams.map((s) => s && s.id).filter(Boolean));
    let c = 1; const freshId = () => { let id; do { id = "s" + (c++); } while (used.has(id)); used.add(id); return id; };
    const out = [];
    for (const s of seams) {
      if (!s || !okRef(s.a) || !okRef(s.b)) continue;
      const seam = {
        id: s.id || freshId(),
        a: { piece: s.a.piece, edge: s.a.edge },
        b: { piece: s.b.piece, edge: s.b.edge },
        // Step-2 dihedral (deg): 0 flat, +valley, −mountain; null = let the fold solver find it.
        foldAngle: (s.foldAngle === 0 || s.foldAngle) ? s.foldAngle : null,
        // Matched arc-length fractions (notch anchors); null = default head-to-tail in the fold.
        anchors: Array.isArray(s.anchors) ? s.anchors.map((an) => ({ ta: +an.ta || 0, tb: +an.tb || 0 })) : null,
      };
      // Step-3 drape attributes (additive): ease (long edge is (1+ease)× the short) + gather/pleat.
      if (s.ease) seam.ease = +s.ease || 0;
      if (s.gather && (s.gather.type === "gather" || s.gather.type === "pleat")) {
        const g = s.gather;
        seam.gather = g.type === "pleat"
          ? { type: "pleat", style: g.style || "knife", count: Math.max(1, g.count | 0 || 4), depth: Math.max(1, +g.depth || 20) }
          : { type: "gather", ratio: Math.max(1, +g.ratio || 1.5), region: Array.isArray(g.region) ? [+g.region[0] || 0, +g.region[1] || 1] : [0, 1] };
      }
      out.push(seam);
    }
    return out;
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
  // edge-local control point [u,v] → world point. chord d = b−a, left-normal n̂; v is scaled
  // by the chord length so the curve is invariant to scale + the shelf-packer's translation.
  function edgeLocalToWorld(a, b, u, v) {
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L;                 // unit left-normal
    return [a.x + u * dx + v * L * nx, a.y + u * dy + v * L * ny];
  }
  // Build a Maker.js model from a node list. `curves` (optional) is aligned to the edges:
  // curves[i] = {type,cp} makes edge i a Bézier/arc sub-model; else a straight Line. With no
  // `curves` this is byte-identical to the original straight-edge builder.
  function modelFromNodes(mk, nodes, curves) {
    const m = { paths: {}, models: {} };
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], b = nodes[(i + 1) % nodes.length];
      const c = curves && curves[i];
      if (c && (c.type === "quad" || c.type === "arc")) {
        const cp = edgeLocalToWorld(a, b, c.cp[0], c.cp[1]);
        m.models["c" + i] = new mk.models.BezierCurve([[a.x, a.y], cp, [b.x, b.y]]);
      } else if (c && c.type === "cubic") {
        const cp1 = edgeLocalToWorld(a, b, c.cp[0], c.cp[1]);
        const cp2 = edgeLocalToWorld(a, b, c.cp[2], c.cp[3]);
        m.models["c" + i] = new mk.models.BezierCurve([[a.x, a.y], cp1, cp2, [b.x, b.y]]);
      } else {
        m.paths["e" + i] = new mk.paths.Line([a.x, a.y], [b.x, b.y]);
      }
    }
    return m;
  }
  // ── dart lowering (pure, Maker-free): split a wedge dart's edge + drop an apex ──────
  // Returns the boundary topology the print AND (M5c) the drape consume, so their edge
  // indexing agrees. `nodes` is the lowered node list (authored corners preserved, dart
  // points spliced in); `edgeMap[i]` = the authored edge a lowered edge came from (−1 for a
  // dart leg); `dartLegs` identifies the two leg edges per wedge dart (M5c sews them shut);
  // `dartFolds` are interior fold lines for slash darts. piece.nodes is NEVER mutated.
  function loweredBoundary(piece) {
    const src = piece.nodes || [];
    const darts = (piece.darts || []).filter((d) => d.kind === "wedge" && d.edge >= 0 && d.edge < src.length);
    // polygon centroid → pick the inward edge-normal for the apex.
    let cx = 0, cy = 0; for (const n of src) { cx += n.x; cy += n.y; } cx /= (src.length || 1); cy /= (src.length || 1);
    // group wedge darts by authored edge, ordered along the edge by center.
    const byEdge = {};
    for (const d of darts) (byEdge[d.edge] = byEdge[d.edge] || []).push(d);
    for (const k in byEdge) byEdge[k].sort((p, q) => p.center - q.center);
    const dartFolds = [];
    for (const d of (piece.darts || [])) {
      if (d.kind !== "slash" || d.edge < 0 || d.edge >= src.length) continue;
      const a = src[d.edge], b = src[(d.edge + 1) % src.length];
      const mid = { x: a.x + d.center * (b.x - a.x), y: a.y + d.center * (b.y - a.y) };
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
      let nx = -dy / L, ny = dx / L;
      if ((cx - mid.x) * nx + (cy - mid.y) * ny < 0) { nx = -nx; ny = -ny; }
      dartFolds.push([[round2(mid.x), round2(mid.y)], [round2(mid.x + nx * d.depth), round2(mid.y + ny * d.depth)]]);
    }
    const nodes = [], edgeMap = [], dartLegs = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      nodes.push({ x: a.x, y: a.y, radius: a.radius || 0, saMm: a.saMm }); // authored corner kept
      const here = byEdge[i];
      if (!here || !here.length) { edgeMap.push(i); continue; }
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      let nx = -dy / L, ny = dx / L;                       // inward normal for this edge
      const midAll = { x: a.x + 0.5 * dx, y: a.y + 0.5 * dy };
      if ((cx - midAll.x) * nx + (cy - midAll.y) * ny < 0) { nx = -nx; ny = -ny; }
      edgeMap.push(i);                                     // a → first split: still authored edge i
      for (const d of here) {
        const cDist = d.center * L, half = Math.min(d.width / 2, cDist, L - cDist);
        const sA = { x: a.x + (cDist - half) * ux, y: a.y + (cDist - half) * uy };
        const sB = { x: a.x + (cDist + half) * ux, y: a.y + (cDist + half) * uy };
        const apex = { x: a.x + cDist * ux + nx * d.depth, y: a.y + cDist * uy + ny * d.depth };
        dartFolds.push([[round2(a.x + cDist * ux), round2(a.y + cDist * uy)], [round2(apex.x), round2(apex.y)]]); // stitch guide
        nodes.push({ x: round2(sA.x), y: round2(sA.y), radius: 0, _dart: true });   // start of leg A
        const legA = nodes.length - 1; edgeMap.push(-1);              // sA → apex (leg A)
        nodes.push({ x: round2(apex.x), y: round2(apex.y), radius: 0, _dart: true });
        const legB = nodes.length - 1; edgeMap.push(-1);              // apex → sB (leg B)
        nodes.push({ x: round2(sB.x), y: round2(sB.y), radius: 0, _dart: true });
        edgeMap.push(i);                                              // sB → next: authored edge i again
        dartLegs.push({ dartId: d.id, legA, legB });
      }
    }
    return { nodes, edgeMap, dartLegs, dartFolds, hasDarts: darts.length > 0 };
  }
  // closed-polygon inward miter offset for VARIABLE per-node seam allowance. `dist(i)` gives
  // the inset (mm) at node i. Returns a closed polyline ([…,first]) or null if it self-folds.
  function insetPolygon(nodes, dist) {
    const n = nodes.length; if (n < 3) return null;
    let cx = 0, cy = 0; for (const p of nodes) { cx += p.x; cy += p.y; } cx /= n; cy /= n;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = nodes[(i - 1 + n) % n], cur = nodes[i], nxt = nodes[(i + 1) % n];
      const inN = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
        let nx = -dy / L, ny = dx / L; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; } return [nx, ny]; };
      const [n1x, n1y] = inN(prev, cur), [n2x, n2y] = inN(cur, nxt);
      let mx = n1x + n2x, my = n1y + n2y; const mL = Math.hypot(mx, my); if (mL < 1e-6) return null;
      mx /= mL; my /= mL; const cosH = mx * n1x + my * n1y; if (cosH < 0.2) return null;   // ~reflex spike → bail
      const d = Math.max(0, dist(i)) / cosH;
      out.push([round2(cur.x + mx * d), round2(cur.y + my * d)]);
    }
    out.push([out[0][0], out[0][1]]);
    // sanity: the offset must shrink the bbox (a flipped/exploded offset is rejected).
    const bo = bbox(out), bi = bbox(nodes);
    if (bo.w > bi.w + 0.5 || bo.h > bi.h + 0.5) return null;
    return out;
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
    const baseR = Math.max(0, piece.cornerRadius || 0);
    const sa = Math.max(0, piece.seamMm || 0);
    const hasCurves = !!(piece.edges && Object.keys(piece.edges).length);
    const hasVarSA = (piece.nodes || []).some((n) => n && n.saMm > 0);
    // Lower darts to boundary topology (no-op when the piece has none); print + drape share it.
    const lb = loweredBoundary(piece);
    const nodes = lb.nodes;                       // authored corners + any dart splits
    // Per-corner radius on the LOWERED nodes: a node's own radius (>0) wins, else the piece
    // default (dart-split points carry radius 0, so they inherit the default like any corner).
    const radii = nodes.map((n) => (n && n._dart ? 0 : (n && n.radius > 0 ? n.radius : baseR)));
    const maxR = radii.reduce((m, v) => Math.max(m, v), 0);
    const mk = maker();
    if (!mk || (maxR === 0 && sa === 0 && !hasCurves && !hasVarSA)) {
      // dependency-free degrade: straight cut (incl. dart splits via lb.nodes), no curves/SA.
      return { cut: nodesToPoints(nodes, piece.closed), seam: null };
    }
    // map each lowered edge to its authored curve (skip curves on dart-split edges — rare combo).
    const dartEdges = new Set(); for (const d of (piece.darts || [])) if (d.kind === "wedge") dartEdges.add(d.edge);
    const curves = hasCurves ? nodes.map((_, i) => {
      const ae = lb.edgeMap[i];
      if (ae < 0 || dartEdges.has(ae)) return null;
      const e = piece.edges[String(ae)];
      return e && e.curve ? e.curve : null;
    }) : null;
    const facet = hasCurves ? Math.min(facetFor(maxR), 1.2) : facetFor(maxR);
    const build = () => modelFromNodes(mk, nodes, curves);
    let model = build();
    if (maxR > 0) {
      try {
        const n = nodes.length;
        const fillets = { paths: {} };
        let added = 0;
        for (let i = 0; i < n; i++) {
          if (radii[i] <= 0) continue;
          const eIn = model.paths["e" + ((i - 1 + n) % n)], eOut = model.paths["e" + i];
          const arc = eIn && eOut ? mk.path.fillet(eIn, eOut, radii[i]) : null;   // both sides straight
          if (arc) fillets.paths["f" + (added++)] = arc;
        }
        model = added ? { models: { base: model, fillets } } : build();
      } catch (_) { model = build(); }
    }
    let cut = flattenModel(mk, model, facet) || nodesToPoints(nodes, piece.closed);
    let seam = null;
    if (hasVarSA && !hasCurves) {
      // VARIABLE seam allowance: per-node inset of the authored polygon (handles a wider hem).
      seam = insetPolygon(piece.nodes, (i) => (piece.nodes[i] && piece.nodes[i].saMm > 0 ? piece.nodes[i].saMm : sa));
    } else if (sa > 0) {
      // uniform offset (now also offsets curves) — unchanged for schema-2 pieces.
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
  // a tick straddling the edge at point (px,py), perpendicular to edge direction (dx,dy unit).
  function tickAt(px, py, dx, dy, len) {
    const nx = -dy, ny = dx, h = (len || 7) / 2;
    return [[round2(px - nx * h), round2(py - ny * h)], [round2(px + nx * h), round2(py + ny * h)]];
  }
  // a LEGACY {x,y} notch point → a short tick straddling the nearest edge, perpendicular to it.
  function notchMark(nodes, pt, len) {
    const n = nodes.length; if (n < 2) return null;
    const ne = nearestEdge(nodes, P(pt)); const a = nodes[ne.edge], b = nodes[(ne.edge + 1) % n];
    let dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); if (L < 1e-6) return null; dx /= L; dy /= L;
    return tickAt(ne.proj.x, ne.proj.y, dx, dy, len);
  }
  // an UPGRADED {edge,t,type} notch → one (single) or two (double) ticks at arc-length t on the
  // authored edge. `double` marks the "back" so a seam can't be sewn reversed (Seamly passmark).
  function notchTicks(nodes, nt) {
    const n = nodes.length; if (n < 2) return [];
    if (!Number.isInteger(nt.edge)) { const m = notchMark(nodes, nt); return m ? [m] : []; }   // legacy {x,y}
    if (nt.edge < 0 || nt.edge >= n) return [];
    const a = nodes[nt.edge], b = nodes[(nt.edge + 1) % n];
    let dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); if (L < 1e-6) return [];
    dx /= L; dy /= L; const t = Math.max(0, Math.min(1, nt.t || 0));
    const px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
    if (nt.type === "double") {
      const o = 2;   // two parallel ticks ~2mm apart along the edge
      return [tickAt(px - dx * o, py - dy * o, dx, dy), tickAt(px + dx * o, py + dy * o, dx, dy)];
    }
    return [tickAt(px, py, dx, dy)];
  }
  // per-piece extra paths/labels (in LOCAL coords): notch ticks + dart fold guides + placement rects.
  function pieceExtras(piece) {
    const paths = [], labels = [];
    for (const nt of (piece.notches || [])) {
      for (const m of notchTicks(piece.nodes, nt)) paths.push({ kind: "cut", points: m });
    }
    // dart fold/stitch guide lines (wedge centerlines + slash fold lines); wedge cuts are in pieceGeom().cut.
    for (const f of loweredBoundary(piece).dartFolds) paths.push({ kind: "seam", points: f });
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
  // doc-level wearer measurements parametrize the dress form (Step 3b). Absent ⇒ no body
  // (bags don't need one). Field-level defaults so a fresh garment previews without entry.
  const DEFAULT_BODY = { heightMm: 1650, bustMm: 920, waistMm: 740, hipMm: 980 };
  function normalizeBody(body) {
    if (!body || typeof body !== "object") return null;
    return {
      heightMm: +body.heightMm > 0 ? +body.heightMm : DEFAULT_BODY.heightMm,
      bustMm: +body.bustMm > 0 ? +body.bustMm : DEFAULT_BODY.bustMm,
      waistMm: +body.waistMm > 0 ? +body.waistMm : DEFAULT_BODY.waistMm,
      hipMm: +body.hipMm > 0 ? +body.hipMm : DEFAULT_BODY.hipMm,
    };
  }
  // legacy {x,y} notch → {edge,t,type} via nearestEdge, on SAVE (load stays non-destructive).
  function migrateNotches(piece) {
    if (!piece.notches || !piece.notches.length) return;
    piece.notches = piece.notches.map((nt) => {
      if (Number.isInteger(nt.edge)) return nt;
      const ne = nearestEdge(piece.nodes, P(nt));
      return ne.edge < 0 ? nt : { edge: ne.edge, t: round2(ne.proj.t), type: "single" };
    });
  }
  // true when the doc uses any schema-3 garment-authoring field (so we bump schema, not before).
  function hasSchema3(pieces, seams, body) {
    if (seams && seams.length) return true;
    if (body) return true;
    return pieces.some((p) => (p.darts && p.darts.length) || (p.edges && Object.keys(p.edges).length)
      || p.place3d || (p.nodes || []).some((n) => n.saMm > 0)
      || (p.notches || []).some((nt) => Number.isInteger(nt.edge)));
  }
  function freeformToDoc(params) {
    params = params || {};
    const pieces = normalizePieces(params);
    for (const p of pieces) migrateNotches(p);   // upgrade legacy {x,y} notches on save
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
    const seams = normalizeSeams(params.seams || [], pieces);
    const body = normalizeBody(params.body);
    const doc = {
      // schema 3 when any schema-3 field (seams / darts / curves / variable-SA / notch-upgrade /
      // place3d / body) is present; else stays schema 2, byte-clean and unchanged.
      name: params.name || "Untitled", kind: "freeform", schema: hasSchema3(pieces, seams, body) ? 3 : 2,
      pieces, seams, paths, labels,
      gridMm: params.gridMm || 5,
      widthMm: Math.max(1, Math.ceil(board.w)), heightMm: Math.max(1, Math.ceil(board.h)),
    };
    if (body) doc.body = body;
    return doc;
  }

  // Export the assembled board (a freeformToDoc result) as a single vector file
  // via Maker.js (loaded only on /edit). Reuses the doc's already-flattened board
  // polylines, so the export matches the printed PDF exactly (WYSIWYG). Our coords
  // are mm, y-up — same convention as Maker.js (its SVG exporter does its own
  // y-flip). format: "svg" | "dxf". Returns the file text, or null if Maker.js is
  // unavailable (Home never loads it) or the export throws.
  function exportBoard(doc, format) {
    const mk = maker();
    if (!mk || !doc) return null;
    const model = { paths: {}, units: mk.unitType.Millimeter };
    let k = 0;
    for (const path of (doc.paths || [])) {
      const pts = path.points || [];
      for (let i = 0; i + 1 < pts.length; i++)
        model.paths["s" + (k++)] = new mk.paths.Line([pts[i][0], pts[i][1]], [pts[i + 1][0], pts[i + 1][1]]);
    }
    try {
      return format === "dxf" ? mk.exporter.toDXF(model) : mk.exporter.toSVG(model);
    } catch (_) { return null; }
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
    rectPiece, normalizePieces, normalizeSeams, normalizeBody, piecesFromDoc, pieceGeom, nearestEdge, notchMark, notchTicks,
    loweredBoundary, DEFAULT_BODY,
    packLayouts, normalizeDoc, freeformToDoc, exportBoard, defaultParams,
  };
})();
