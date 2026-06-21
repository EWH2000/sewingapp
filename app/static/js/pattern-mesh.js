// pattern-mesh.js — panel triangulation for the cloth drape (Step 3 / milestone M4).
//
// Pure, headless, three-free (mirrors pattern-fold.js): a classic IIFE attaching
// `window.PatternMesh` so the Node test tools/preview/verify-mesh.mjs can `eval` it with a
// plain `window` shim, and the browser drape code can read the global. Depends on
// `window.poly2tri` (the vendored CDT — Steiner-point constrained Delaunay) and, optionally,
// `window.PatternGeom` (bbox/segment-distance helpers). NO three.js, NO DOM.
//
// What it does: turns ONE piece's flat outline into a simulation mesh — a boundary resampled
// to ~uniform spacing `h`, interior Steiner points on an h-grid, constrained-Delaunay
// triangulated together. A boundary-only polygon has no interior DOF (can't bend/inflate);
// the interior vertices are what let the XPBD solver (pattern-cloth.js, next) bend and puff.
//
// Output (piece-local mm, y-up — same frame as the authored nodes):
//   { nodes:[[x,y]…], boundary:[idx…], boundaryMeta:[{edge,t}…], tris:[[a,b,c]…],
//     dist:[[i,j,rest]…], bend:[[i,j,rest]…] }
// - boundary[] is the outline loop in order; boundaryMeta[k] tags boundary node k with the
//   AUTHORED edge it sits on (edge i = node i→node i+1) and its arc-length fraction t∈[0,1)
//   along that edge — this is what seam stitching (pattern-cloth) uses to pair nodes across a
//   seam by arc-length, so unequal-length edges gather correctly.
// - dist[] = every unique triangle edge (a stretch spring); bend[] = the opposite-vertex pair
//   across each interior shared edge (the cheap dihedral-bending approximation).

(function () {
  "use strict";

  const p2t = () => (typeof window !== "undefined" && window.poly2tri) || null;
  const G = () => (typeof window !== "undefined" && window.PatternGeom) || null;

  const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  function bboxOf(nodes) {
    const g = G();
    if (g && g.bbox) return g.bbox(nodes);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { const x = n.x != null ? n.x : n[0], y = n.y != null ? n.y : n[1];
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  // Ray-cast point-in-polygon (lifted to the pure layer from editor.js's UI copy). `poly`
  // is [[x,y]…] or [{x,y}…]; the boundary itself counts as outside (we want STRICT interior
  // for Steiner points, the margin test handles near-boundary cases).
  function pointInPoly(x, y, poly) {
    const X = (p) => (p.x != null ? p.x : p[0]), Y = (p) => (p.y != null ? p.y : p[1]);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = X(poly[i]), yi = Y(poly[i]), xj = X(poly[j]), yj = Y(poly[j]);
      const hit = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }

  // min distance from (x,y) to the polygon boundary (over all edges).
  function distToBoundary(x, y, nodes) {
    const g = G();
    let best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], b = nodes[(i + 1) % nodes.length];
      const d = g && g.pointToSegmentDist
        ? g.pointToSegmentDist({ x, y }, a, b)
        : segDist(x, y, a.x != null ? a.x : a[0], a.y != null ? a.y : a[1], b.x != null ? b.x : b[0], b.y != null ? b.y : b[1]);
      if (d < best) best = d;
    }
    return best;
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Resample the AUTHORED-node outline to ~uniform spacing h. Keeps every authored vertex
  // (so seam-edge identity survives) and subdivides each edge into segments of ≈h. Returns
  // points [[x,y]…] AND meta [{edge,t}…] (edge = authored edge index, t = fraction along it).
  function resampleBoundary(nodes, h) {
    const pts = [], meta = [];
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = [nodes[i].x, nodes[i].y], b = [nodes[(i + 1) % n].x, nodes[(i + 1) % n].y];
      const L = dist2d(a, b);
      const segs = Math.max(1, Math.round(L / h));
      for (let s = 0; s < segs; s++) {          // include start vertex, exclude end (next edge owns it)
        const t = s / segs;
        pts.push(lerp2(a, b, t));
        meta.push({ edge: i, t });
      }
    }
    return { pts, meta };
  }

  // Interior Steiner points on an h-grid, strictly inside with a margin so poly2tri doesn't
  // get points right on the contour (which makes slivers / can fail).
  function interiorGrid(nodes, h) {
    const bb = bboxOf(nodes);
    const margin = 0.45 * h;
    const out = [];
    for (let x = bb.minX + h; x < bb.maxX; x += h) {
      for (let y = bb.minY + h; y < bb.maxY; y += h) {
        if (pointInPoly(x, y, nodes) && distToBoundary(x, y, nodes) > margin) out.push([x, y]);
      }
    }
    return out;
  }

  // dedupe an undirected edge list into [i,j,rest] with i<j (rest = current length).
  function edgeConstraints(nodes, pairs) {
    const seen = {}, out = [];
    for (const [a, b] of pairs) {
      const i = Math.min(a, b), j = Math.max(a, b);
      if (i === j) continue;
      const key = i + "_" + j;
      if (seen[key]) continue;
      seen[key] = true;
      out.push([i, j, round3(dist2d(nodes[i], nodes[j]))]);
    }
    return out;
  }

  // Triangulate a piece into a sim mesh. h = target node spacing (mm). Never throws: on a
  // poly2tri error or absence it degrades to a boundary + centroid fan (minimal interior DOF).
  function triangulatePiece(piece, h) {
    const nodes0 = (piece && piece.nodes) || [];
    h = h > 0 ? h : 20;
    if (nodes0.length < 3) return { nodes: [], boundary: [], boundaryMeta: [], tris: [], dist: [], bend: [] };

    const { pts: bPts, meta: bMeta } = resampleBoundary(nodes0, h);
    const iPts = interiorGrid(nodes0, h);

    const nodes = [], boundary = [], boundaryMeta = [];
    bPts.forEach((p, k) => { boundary.push(nodes.length); boundaryMeta.push(bMeta[k]); nodes.push([p[0], p[1]]); });

    let tris = null;
    const lib = p2t();
    if (lib) {
      try {
        const Point = lib.Point;
        const contour = bPts.map((p, k) => { const pt = new Point(p[0], p[1]); pt.__i = k; return pt; });
        const swctx = new lib.SweepContext(contour);
        for (const ip of iPts) { const pt = new Point(ip[0], ip[1]); pt.__i = nodes.length; nodes.push([ip[0], ip[1]]); swctx.addPoint(pt); }
        swctx.triangulate();
        const idxOf = (pt) => { if (pt.__i == null) { pt.__i = nodes.length; nodes.push([pt.x, pt.y]); } return pt.__i; };
        tris = swctx.getTriangles().map((t) => [idxOf(t.getPoint(0)), idxOf(t.getPoint(1)), idxOf(t.getPoint(2))]);
      } catch (_) { tris = null; }
    }
    if (!tris) {                                   // fallback: centroid fan (boundary + 1 interior)
      let cx = 0, cy = 0; for (const p of bPts) { cx += p[0]; cy += p[1]; }
      cx /= bPts.length; cy /= bPts.length;
      const c = nodes.length; nodes.push([cx, cy]);
      tris = [];
      for (let k = 0; k < boundary.length; k++) tris.push([boundary[k], boundary[(k + 1) % boundary.length], c]);
    }

    // distance constraints = unique triangle edges
    const edgePairs = [];
    for (const [a, b, c] of tris) { edgePairs.push([a, b], [b, c], [c, a]); }
    const distC = edgeConstraints(nodes, edgePairs);

    // bending constraints = opposite vertices across each interior shared edge
    const edgeTris = {};
    const addET = (a, b, opp) => { const i = Math.min(a, b), j = Math.max(a, b), key = i + "_" + j; (edgeTris[key] = edgeTris[key] || []).push(opp); };
    for (const [a, b, c] of tris) { addET(a, b, c); addET(b, c, a); addET(c, a, b); }
    const bendPairs = [];
    for (const key in edgeTris) { const opp = edgeTris[key]; if (opp.length === 2) bendPairs.push([opp[0], opp[1]]); }
    const bendC = edgeConstraints(nodes, bendPairs);

    return { nodes, boundary, boundaryMeta, tris, dist: distC, bend: bendC };
  }

  // ── seam correspondence (§6.3) ──────────────────────────────────────────────────
  // The boundary mesh nodes lying on one authored edge, from t=0 to t=1 inclusive. The
  // resampler tags interior-of-edge nodes with that edge; the edge's far endpoint is the
  // next edge's t=0 node, so we append it as t=1. Returns [{node, t}…] sorted by t.
  function edgeNodes(mesh, edge) {
    const B = mesh.boundary, Meta = mesh.boundaryMeta, L = B.length;
    const on = [];
    for (let k = 0; k < L; k++) if (Meta[k].edge === edge) on.push(k);
    if (!on.length) return [];
    const out = on.map((k) => ({ node: B[k], t: Meta[k].t }));
    out.push({ node: B[(on[on.length - 1] + 1) % L], t: 1 });   // far endpoint = next edge's start
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // Pair boundary nodes across a seam (piece A edge eA ↔ piece B edge eB) by arc-length, for
  // the XPBD sewing springs. Direction follows the fold's convention: head-to-tail (default)
  // pairs A(t) with B(1−t); head-to-head (opts.flip) pairs A(t) with B(t) — matching
  // closureGap()/flipFromAnchors in pattern-fold.js. Unequal-length edges pair fine (the
  // shorter side's nodes get reused → the longer side gathers). Returns [[nodeA, nodeB]…]
  // node-index pairs (deduped). Notch-bounded sub-spans (anchors) are a later upgrade —
  // today's seam `anchors` only encode direction (flip), not notch positions.
  function seamPairs(meshA, eA, meshB, eB, opts) {
    opts = opts || {};
    const A = edgeNodes(meshA, eA), B = edgeNodes(meshB, eB);
    if (!A.length || !B.length) return [];
    const flip = !!opts.flip;
    const fracB = (t) => (flip ? t : 1 - t);                    // B's node t → matching fraction
    const nearest = (list, target, key) => {
      let best = list[0], bd = Infinity;
      for (const it of list) { const d = Math.abs(key(it) - target); if (d < bd) { bd = d; best = it; } }
      return best;
    };
    const N = Math.max(A.length, B.length);
    const pairs = [], seen = {};
    for (let k = 0; k < N; k++) {
      const f = N === 1 ? 0 : k / (N - 1);
      const a = nearest(A, f, (it) => it.t);
      const b = nearest(B, f, (it) => fracB(it.t));
      const key = a.node + "_" + b.node;
      if (seen[key]) continue;
      seen[key] = true;
      pairs.push([a.node, b.node]);
    }
    return pairs;
  }

  const round3 = (v) => Math.round(v * 1000) / 1000;

  window.PatternMesh = { triangulatePiece, pointInPoly, resampleBoundary, interiorGrid, edgeNodes, seamPairs };
})();
