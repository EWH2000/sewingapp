// pattern-fold.js — rigid fold-up solver (Step 2 / milestone M3).
//
// Pure, headless, dependency-light: a classic IIFE attaching `window.PatternFold`
// (mirrors pattern-geom.js) so the Node test tools/preview/verify-fold.mjs can `eval`
// it with a plain `window` shim, and preview3d.js can read the global. NO three.js, NO
// DOM — that is deliberate: keeping the solver three-free is what keeps the headless
// test a simple eval (no module resolver), and preview3d.js is the ONLY place three.js
// meets the fold.
//
// What it does: takes a freeform doc's flat pattern `pieces` (each a closed polygon of
// authored `nodes`, piece-local mm, y-up) plus the `seams` graph (which authored edge of
// which piece is sewn to which) and folds the pieces up into an assembled 3D shape —
// lay the base flat on the floor, hinge each sewn piece up by its seam's dihedral angle,
// and reconcile the seams that close cycles (a bag's walls close a loop) with a small
// Levenberg–Marquardt closure solve. Returns ABSOLUTE per-piece rigid transforms
// (pos + quat) so the renderer just places each piece's local nodes; no scene-graph
// nesting, and the math is fully unit-testable.
//
// World convention (matches preview3d.js M1): y-up millimetres, the root/base piece lies
// flat in the y=0 plane (the floor), walls fold UP (+y). A piece's local point (x,y)
// embeds as (x,y,0) then world = pos + quat·(x,y,0).
//
// Edge convention (matches pattern-geom.js): edge i = the boundary edge leaving node i
// (segment node[i] → node[(i+1)%n]) on the AUTHORED node polygon — panels are rigid
// polygons, so the fold hinges on authored nodes; fillets/curves are cosmetic (a Step-3
// drape concern) and only texture the faces (preview3d.js).

(function () {
  "use strict";

  // ── tiny 3D vector / quaternion / matrix library (G has none of this) ──────────
  const EPS = 1e-9;
  const DEG = Math.PI / 180;

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  function normalize(a) {
    const l = len(a);
    return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
  }

  // quat = [x,y,z,w]
  function quatFromAxisAngle(u, angle) {
    const h = angle / 2, s = Math.sin(h);
    return [u[0] * s, u[1] * s, u[2] * s, Math.cos(h)];
  }
  function quatMul(a, b) {
    const ax = a[0], ay = a[1], az = a[2], aw = a[3];
    const bx = b[0], by = b[1], bz = b[2], bw = b[3];
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  }
  function quatRotateVec(q, v) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    // t = 2 * cross(q.xyz, v); v + w*t + cross(q.xyz, t)
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
      v[0] + w * tx + (y * tz - z * ty),
      v[1] + w * ty + (z * tx - x * tz),
      v[2] + w * tz + (x * ty - y * tx),
    ];
  }
  // Quaternion from a column-major 3x3 rotation matrix m (m[0..2]=col0, etc.).
  // Shepperd's method: branch on the largest diagonal to avoid a near-zero divisor.
  function quatFromMat3(m) {
    const r00 = m[0], r10 = m[1], r20 = m[2];
    const r01 = m[3], r11 = m[4], r21 = m[5];
    const r02 = m[6], r12 = m[7], r22 = m[8];
    const tr = r00 + r11 + r22;
    let x, y, z, w, s;
    if (tr > 0) {
      s = Math.sqrt(tr + 1) * 2;          // s = 4w
      w = 0.25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s;
    } else if (r00 > r11 && r00 > r22) {
      s = Math.sqrt(1 + r00 - r11 - r22) * 2;   // s = 4x
      w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s;
    } else if (r11 > r22) {
      s = Math.sqrt(1 + r11 - r00 - r22) * 2;   // s = 4y
      w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s;
    } else {
      s = Math.sqrt(1 + r22 - r00 - r11) * 2;   // s = 4z
      w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s;
    }
    return [x, y, z, w];
  }

  // Proper rotation (quat) sending the child's local frame to a world frame:
  // child edge-dir e_c → world e_w, child normal n_c → world n_w. Both frames are
  // orthonormal + right-handed, so the result never reflects (det +1) — far-side
  // landing comes from the e_w DIRECTION choice, not from a determinant flip.
  function rotFromFrames(e_c, n_c, e_w, n_w) {
    const fc1 = normalize(e_c), fc3 = normalize(n_c), fc2 = cross(fc3, fc1);
    const fw1 = normalize(e_w), fw3 = normalize(n_w), fw2 = cross(fw3, fw1);
    // R maps fc_k → fw_k. Column-major: col_j = Σ_k fw_k * fc_k[j].
    const col = (j) => add(add(scale(fw1, fc1[j]), scale(fw2, fc2[j])), scale(fw3, fc3[j]));
    const c0 = col(0), c1 = col(1), c2 = col(2);
    return quatFromMat3([c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]]);
  }

  // Rigid transform T = { pos:[x,y,z], quat:[x,y,z,w] }. applyT places a local point.
  const applyT = (T, v) => add(T.pos, quatRotateVec(T.quat, v));
  // Compose so applyT(AB, v) === applyT(A, applyT(B, v)).
  const composeT = (A, B) => ({
    pos: add(A.pos, quatRotateVec(A.quat, B.pos)),
    quat: quatMul(A.quat, B.quat),
  });
  // Rigid rotation by `angle` about the world line through `a` with unit axis `u`.
  function aboutLine(a, u, angle) {
    const q = quatFromAxisAngle(u, angle);
    return { quat: q, pos: sub(a, quatRotateVec(q, a)) };
  }

  // ── polygon helpers on authored nodes [{x,y}] (edge i = node i → node (i+1)%n) ──
  function signedArea(nodes) {
    let s = 0;
    for (let i = 0, n = nodes.length; i < n; i++) {
      const a = nodes[i], b = nodes[(i + 1) % n];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }
  const polygonArea = (nodes) => Math.abs(signedArea(nodes));
  function centroid3(nodes) {
    const A = signedArea(nodes), n = nodes.length;
    if (Math.abs(A) < 1e-6) {  // degenerate — fall back to the vertex mean
      let mx = 0, my = 0;
      for (const p of nodes) { mx += p.x; my += p.y; }
      return [mx / n, my / n, 0];
    }
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      const a = nodes[i], b = nodes[(i + 1) % n];
      const cr = a.x * b.y - b.x * a.y;
      cx += (a.x + b.x) * cr; cy += (a.y + b.y) * cr;
    }
    return [cx / (6 * A), cy / (6 * A), 0];
  }
  const node3 = (nodes, i) => { const p = nodes[i % nodes.length]; return [p.x, p.y, 0]; };
  const edgeLen2d = (nodes, i) => {
    const n = nodes.length, a = nodes[i % n], b = nodes[(i + 1) % n];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  // Small dense linear solve A x = b (k×k, partial pivot) for the LM normal equations.
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat(b[i]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;        // singular
      if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
      const pivVal = M[col][col];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / pivVal;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / M[i][i]);
  }

  // Direction of a seam: head-to-tail (the common case — adjacent pieces meet in
  // opposite order) vs head-to-head (flipped). anchors encode it: head-to-tail pairs
  // t=0↔t=1 (its two fractions differ ~1); head-to-head pairs t=0↔t=0 (differ ~0).
  function flipFromAnchors(anchors) {
    if (Array.isArray(anchors) && anchors[0] && typeof anchors[0].ta === "number")
      return Math.abs(anchors[0].ta - anchors[0].tb) < 0.5;
    return null;   // unknown → infer later
  }

  // The constant −90°-about-X placement that lays a piece's local (x,y,0) onto the
  // floor: world (x, 0, −y), local normal +Z → world +Y. `origin` shifts it on the
  // floor (for disconnected sub-roots placed beside the bag).
  function rootTransform(origin) {
    return { quat: quatFromAxisAngle([1, 0, 0], -Math.PI / 2), pos: origin || [0, 0, 0] };
  }

  // ── the solver ─────────────────────────────────────────────────────────────────
  // foldDoc(pieces, seams, opts) — opts.root forces the floor piece (else auto-detect).
  function foldDoc(pieces, seams, opts) {
    opts = opts || {};
    const G = (typeof window !== "undefined" && window.PatternGeom) || null;
    // Normalize (stable ids, drop dangling/out-of-range refs) when geom is present.
    if (G && G.normalizePieces) pieces = G.normalizePieces({ pieces: pieces || [] });
    else pieces = (pieces || []).map((p, i) => Object.assign({ id: p.id || "p" + (i + 1) }, p));
    if (G && G.normalizeSeams) seams = G.normalizeSeams(seams || [], pieces);
    else seams = seams || [];

    const byId = {};
    pieces.forEach((p) => { byId[p.id] = p; });
    const tolClose = 1.0, tolOpen = 15.0;       // mm: closure gap thresholds

    // 1. Classify seams: self-seams aside; hinge-ability by paired-edge length match.
    const selfSeams = [], usable = [];
    let nonHingeable = 0;
    for (const s of seams) {
      if (!byId[s.a.piece] || !byId[s.b.piece]) continue;
      if (s.a.piece === s.b.piece) { selfSeams.push(s); continue; }     // dart/self — Step 3
      const LA = edgeLen2d(byId[s.a.piece].nodes, s.a.edge);
      const LB = edgeLen2d(byId[s.b.piece].nodes, s.b.edge);
      const tolLen = Math.max(1.5, 0.01 * Math.min(LA, LB));
      const hingeable = LA > EPS && LB > EPS && Math.abs(LA - LB) <= tolLen;
      if (hingeable) usable.push(s); else nonHingeable++;
    }

    // 2. Adjacency over hingeable seams (sorted by id → deterministic BFS).
    const sortedSeams = usable.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const adj = {};
    pieces.forEach((p) => { adj[p.id] = []; });
    sortedSeams.forEach((s) => { adj[s.a.piece].push(s); adj[s.b.piece].push(s); });

    // 3. Roots: opts.root if valid; else highest hinge-degree, tie-break largest area.
    const degree = {}; pieces.forEach((p) => { degree[p.id] = adj[p.id].length; });
    function pickRoot(candidates) {
      let best = null;
      for (const id of candidates) {
        const p = byId[id], d = degree[id], a = polygonArea(p.nodes);
        if (!best || d > best.d || (d === best.d && a > best.a)) best = { id, d, a };
      }
      return best && best.id;
    }
    const forced = opts.root && byId[opts.root] ? opts.root : null;

    // 4. Spanning forest (BFS). Tree seams → hinges; hingeable seams whose both ends
    //    are already in a tree → closure constraints (one cycle each).
    const visited = {}, parentHinge = {}, order = [], roots = [], rootOrigin = {};
    const closures = [];
    let cycles = 0;
    let xCursor = 0;
    const allIds = pieces.map((p) => p.id);
    // main component first (forced/auto root), then remaining components by the same rule
    const remaining = () => allIds.filter((id) => !visited[id]);
    let first = true;
    while (remaining().length) {
      const pool = remaining();
      const rootId = first && forced ? forced : pickRoot(pool);
      first = false;
      // place this component's root flat on the floor; sub-roots shelf-pack on +X
      const bb = G && G.bbox ? G.bbox(byId[rootId].nodes) : bboxNodes(byId[rootId].nodes);
      rootOrigin[rootId] = [xCursor, 0, 0];
      roots.push(rootId);
      visited[rootId] = true;
      const queue = [rootId];
      while (queue.length) {
        const cur = queue.shift();
        for (const s of adj[cur]) {
          const other = s.a.piece === cur ? s.b.piece : s.a.piece;
          if (!visited[other]) {
            visited[other] = true;
            parentHinge[other] = treeHinge(cur, other, s, byId);
            order.push(other);
            queue.push(other);
          } else if (parentHinge[cur] && parentHinge[cur].seamId === s.id) {
            // the edge we descended on — not a closure
          } else if (!isTreeEdge(parentHinge, cur, other, s.id)) {
            closures.push(s); cycles++;
          }
        }
      }
      // advance the shelf cursor past this root's flat width (+ gap)
      xCursor += Math.max(bb.w, 1) + 50;
    }
    // de-dup closures (each undirected seam seen from both endpoints); honor authored
    // direction (anchors) on closure seams too — else the flip toggle would be ignored here.
    const closeSeen = {}, closureSeams = [];
    for (const s of closures) {
      if (closeSeen[s.id]) continue;
      closeSeen[s.id] = true;
      s._forcedFlip = flipFromAnchors(s.anchors);
      closureSeams.push(s);
    }
    cycles = closureSeams.length;

    // 6/7/8. Forward fold setup. Free hinges = tree hinges with null foldAngle.
    const freeHinges = [];
    for (const id of order) {
      const h = parentHinge[id];
      h.angle = h.foldAngle == null ? Math.PI / 2 : h.foldAngle * DEG;   // init guess
      if (h.foldAngle == null) { h.free = true; h.freeIndex = freeHinges.length; freeHinges.push(h); }
      else h.free = false;
    }
    // ancestor hinge chain per piece (root → piece), for the closure Jacobian.
    const ancestors = {};
    for (const id of order) {
      const h = parentHinge[id];
      ancestors[id] = (ancestors[h.parent] ? ancestors[h.parent].slice() : []).concat([h]);
    }

    function forwardPass() {
      const WT = {};
      for (const id of roots) WT[id] = rootTransform(rootOrigin[id]);
      for (const id of order) {
        const h = parentHinge[id];
        const fold = aboutLine(h.geom.H0_loc, h.geom.u_loc, h.angle);
        WT[id] = composeT(WT[h.parent], composeT(fold, h.geom.flat));
      }
      return WT;
    }
    // sum of closure gaps at the current config; also (re)sets each closure's pairing.
    function evalClosureGap() {
      const WT = forwardPass();
      let sum = 0;
      for (const s of closureSeams) {
        s._flip = s._forcedFlip != null ? s._forcedFlip : inferFlip(s, WT, byId);
        sum += closureGap(s, WT, byId);
      }
      return sum;
    }

    // 5. Seam DIRECTION (head-to-tail vs head-to-head). It can't be a fixed default —
    //    a box needs one, a tube the other, depending on each piece's edge winding. Honor
    //    anchors when authored; otherwise SEARCH the per-tree-seam directions for the
    //    globally-consistent assignment that closes the cycles (= the physical folding).
    //    Closure-seam directions are inferred (min gap) inside evalClosureGap.
    const order_ = order.slice();
    const searchable = order_.map((id) => parentHinge[id]).filter((h) => h._forcedFlip == null);
    order_.forEach((id) => { const h = parentHinge[id]; setFlip(h, h._forcedFlip != null ? h._forcedFlip : false, byId); });
    if (closureSeams.length && searchable.length) {
      if (searchable.length <= 16) {
        let best = Infinity, bestMask = 0;
        const N = 1 << searchable.length;
        for (let mask = 0; mask < N; mask++) {
          for (let i = 0; i < searchable.length; i++) setFlip(searchable[i], !!(mask & (1 << i)), byId);
          const g = evalClosureGap();
          if (g < best) { best = g; bestMask = mask; }
        }
        for (let i = 0; i < searchable.length; i++) setFlip(searchable[i], !!(bestMask & (1 << i)), byId);
      } else {                                   // greedy coordinate descent for big graphs
        let cur = evalClosureGap();
        for (let round = 0, improved = true; improved && round < 6; round++) {
          improved = false;
          for (const h of searchable) {
            setFlip(h, !h.flip, byId); const g = evalClosureGap();
            if (g < cur - 1e-9) { cur = g; improved = true; } else setFlip(h, !h.flip, byId);
          }
        }
      }
    }
    evalClosureGap();   // lock in each closure seam's chosen pairing (sets s._flip)

    // 9. Closure solve (LM) over the free tree-hinge angles.
    let WT;
    if (freeHinges.length && closureSeams.length) {
      runLM(freeHinges, closureSeams, parentHinge, ancestors, byId, forwardPass);
    }
    WT = forwardPass();

    // residual gap per closure seam at the final config
    const closureOut = closureSeams.map((s) => ({ seam: s.id, gapMm: round3(closureGap(s, WT, byId)) }));
    for (const s of selfSeams) closureOut.push({ seam: s.id, gapMm: null, selfSeam: true });
    const maxGap = closureOut.reduce((m, c) => (c.gapMm != null && c.gapMm > m ? c.gapMm : m), 0);

    // 11. Cosmetic: drop the whole assembly so its lowest point sits on the floor (y=0).
    let minY = Infinity;
    for (const p of pieces) {
      const T = WT[p.id]; if (!T) continue;
      for (let i = 0; i < p.nodes.length; i++) { const w = applyT(T, node3(p.nodes, i)); if (w[1] < minY) minY = w[1]; }
    }
    if (isFinite(minY) && Math.abs(minY) > 1e-6) for (const id in WT) WT[id].pos = [WT[id].pos[0], WT[id].pos[1] - minY, WT[id].pos[2]];

    // 12. Mode (degradation ladder).
    let mode;
    if (!usable.length && !nonHingeable) mode = "tree";        // no seams → flat layout
    else if (nonHingeable) mode = "tree";                       // an eased/mismatched seam
    else if (!cycles) mode = "closed";                          // a tree always "closes"
    else if (maxGap < tolClose) mode = "closed";
    else if (maxGap < tolOpen) mode = "open";
    else mode = "tree";

    const transforms = {};
    for (const p of pieces) if (WT[p.id]) transforms[p.id] = { pos: WT[p.id].pos, quat: WT[p.id].quat };

    return {
      mode,
      transforms,
      root: roots[0],
      cycles,
      closures: closureOut,
      // additive debug field (recovered angles/axes) — read by the headless test.
      hinges: order.map((id) => {
        const h = parentHinge[id];
        return { seam: h.seamId, parent: h.parent, child: id, angleDeg: round3(h.angle / DEG), free: !!h.free, flip: !!h.flip };
      }),
      nonHingeable,
    };
  }

  // A tree hinge attaching `child` to already-placed `parent` along seam `s` — metadata
  // only (parent/child/edges/foldAngle/forced direction). Geometry is built by setFlip,
  // because the seam direction (flip) is searched, not fixed.
  function treeHinge(parentId, childId, s, byId) {
    const pIsA = s.a.piece === parentId;
    return {
      seamId: s.id, parent: parentId, child: childId,
      eP: pIsA ? s.a.edge : s.b.edge, eC: pIsA ? s.b.edge : s.a.edge,
      foldAngle: s.foldAngle, _forcedFlip: flipFromAnchors(s.anchors),
      flip: false, geom: null,
    };
  }
  // Set a hinge's direction and (re)build its PARENT-LOCAL geometry: the child's flat
  // (coplanar) placement and the hinge axis. All independent of fold angles, so the
  // forward pass just composes ancestor world transforms with this fixed relative pose.
  function setFlip(h, flip, byId) {
    if (h.flip === flip && h.geom) return;
    h.flip = flip;
    h.geom = hingeGeom(byId[h.parent].nodes, byId[h.child].nodes, h.eP, h.eC, flip);
  }
  function hingeGeom(Pn, Cn, eP, eC, flip) {
    const H0 = node3(Pn, eP), H1 = node3(Pn, (eP + 1) % Pn.length);   // parent-local edge
    const cA = node3(Cn, eC), cB = node3(Cn, (eC + 1) % Cn.length);   // child-local edge
    // head-to-tail: cA meets H1, cB meets H0 (child edge dir → H0−H1); head-to-head flips.
    const e_w = flip ? sub(H1, H0) : sub(H0, H1);
    const target = flip ? H0 : H1;
    const e_c = sub(cB, cA);
    const n_c = [0, 0, signedArea(Cn) >= 0 ? 1 : -1];        // winding-robust child up
    const qFlat = rotFromFrames(e_c, n_c, e_w, [0, 0, 1]);   // parent-local up = +Z
    const flat = { quat: qFlat, pos: sub(target, quatRotateVec(qFlat, cA)) };
    // hinge axis (parent-local); canonicalize sign so +angle lifts the child toward +Z.
    let u = normalize(sub(H1, H0));
    if (dot(cross(u, sub(applyT(flat, centroid3(Cn)), H0)), [0, 0, 1]) < 0) u = scale(u, -1);
    return { H0_loc: H0, u_loc: u, flat };
  }

  function isTreeEdge(parentHinge, cur, other, seamId) {
    return (parentHinge[other] && parentHinge[other].seamId === seamId)
        || (parentHinge[cur] && parentHinge[cur].seamId === seamId);
  }

  // 3D endpoints of a seam's two paired edges, given world transforms.
  function seamEndpoints(s, WT, byId) {
    const A = byId[s.a.piece], B = byId[s.b.piece];
    const TA = WT[s.a.piece], TB = WT[s.b.piece];
    const nA = A.nodes.length, nB = B.nodes.length;
    return {
      A0: applyT(TA, node3(A.nodes, s.a.edge)), A1: applyT(TA, node3(A.nodes, (s.a.edge + 1) % nA)),
      B0: applyT(TB, node3(B.nodes, s.b.edge)), B1: applyT(TB, node3(B.nodes, (s.b.edge + 1) % nB)),
    };
  }
  function closureGap(s, WT, byId) {
    const e = seamEndpoints(s, WT, byId);
    // head-to-tail: A0↔B1, A1↔B0; head-to-head: A0↔B0, A1↔B1.
    const g0 = s._flip ? len(sub(e.A0, e.B0)) : len(sub(e.A0, e.B1));
    const g1 = s._flip ? len(sub(e.A1, e.B1)) : len(sub(e.A1, e.B0));
    return Math.max(g0, g1);
  }
  function inferFlip(s, WT, byId) {
    const e = seamEndpoints(s, WT, byId);
    const ht = Math.max(len(sub(e.A0, e.B1)), len(sub(e.A1, e.B0)));   // head-to-tail
    const hh = Math.max(len(sub(e.A0, e.B0)), len(sub(e.A1, e.B1)));   // head-to-head
    return hh < ht;
  }

  // Levenberg–Marquardt: minimize Σ‖closure gaps‖² over the free tree-hinge angles,
  // with a weak regularizer pulling free angles toward θ_pref=90° (breaks the gauge
  // freedom of a slack tube). Analytic Jacobian ∂P/∂θ_h = u_h × (P − a_h) for ancestor
  // hinges, recomputed each iteration at the current (folded) config; Marquardt damping
  // (λ·diag(JᵀJ), not λI). Tiny problems (<10 unknowns) → a few iterations.
  function runLM(freeHinges, closureSeams, parentHinge, ancestors, byId, forwardPass) {
    const k = freeHinges.length;
    const thetaPref = Math.PI / 2;
    const muW = 0.5 / 1.0;            // √μ — 1 rad of slack ≈ a 0.5 mm gap
    let lambda = 1e-3;

    function residualsAndJac(theta) {
      for (let i = 0; i < k; i++) freeHinges[i].angle = theta[i];
      const WT = forwardPass();
      // current world axis/pivot of each free hinge (depends on its ancestors, not θ_h)
      const axis = {}, pivot = {};
      for (const h of freeHinges) {
        const Tp = WT[h.parent];
        pivot[h.freeIndex] = applyT(Tp, h.geom.H0_loc);
        axis[h.freeIndex] = normalize(quatRotateVec(Tp.quat, h.geom.u_loc));
      }
      const r = [], J = [];
      const ancHinges = (pieceId) => ancestors[pieceId] || [];
      function pushPoint(P, ownerId, signA, P2, owner2Id, sign2) {
        // a residual component = signA·P + sign2·P2 (each a 3-vector point); 3 rows.
        for (let d = 0; d < 3; d++) {
          r.push(signA * P[d] + sign2 * P2[d]);
          const row = new Array(k).fill(0);
          for (const h of ancHinges(ownerId)) if (h.free) { const dP = cross(axis[h.freeIndex], sub(P, pivot[h.freeIndex])); row[h.freeIndex] += signA * dP[d]; }
          for (const h of ancHinges(owner2Id)) if (h.free) { const dP = cross(axis[h.freeIndex], sub(P2, pivot[h.freeIndex])); row[h.freeIndex] += sign2 * dP[d]; }
          J.push(row);
        }
      }
      for (const s of closureSeams) {
        const e = seamEndpoints(s, WT, byId);
        if (s._flip) {            // A0↔B0, A1↔B1
          pushPoint(e.A0, s.a.piece, 1, e.B0, s.b.piece, -1);
          pushPoint(e.A1, s.a.piece, 1, e.B1, s.b.piece, -1);
        } else {                  // A0↔B1, A1↔B0
          pushPoint(e.A0, s.a.piece, 1, e.B1, s.b.piece, -1);
          pushPoint(e.A1, s.a.piece, 1, e.B0, s.b.piece, -1);
        }
      }
      // regularizer rows
      for (let i = 0; i < k; i++) {
        r.push(muW * (theta[i] - thetaPref));
        const row = new Array(k).fill(0); row[i] = muW; J.push(row);
      }
      return { r, J };
    }
    const cost = (r) => r.reduce((a, v) => a + v * v, 0);

    let theta = freeHinges.map((h) => h.angle);
    let { r, J } = residualsAndJac(theta);
    let c = cost(r);
    for (let iter = 0; iter < 60; iter++) {
      // normal equations A = JᵀJ + λ·diag(JᵀJ), g = Jᵀr
      const A = [], g = new Array(k).fill(0);
      for (let i = 0; i < k; i++) { A.push(new Array(k).fill(0)); }
      for (let i = 0; i < k; i++) {
        for (let row = 0; row < r.length; row++) {
          g[i] += J[row][i] * r[row];
          for (let j = 0; j < k; j++) A[i][j] += J[row][i] * J[row][j];
        }
      }
      for (let i = 0; i < k; i++) A[i][i] += lambda * (A[i][i] || 1);
      const delta = solveLinear(A, g.map((v) => -v));
      if (!delta) { lambda = Math.min(lambda * 3, 1e7); continue; }
      const tryTheta = theta.map((t, i) => t + delta[i]);
      const trial = residualsAndJac(tryTheta);
      const tc = cost(trial.r);
      if (tc < c) {
        theta = tryTheta; r = trial.r; J = trial.J; c = tc;
        lambda = Math.max(lambda / 3, 1e-7);
        let step = 0; for (const d of delta) step += d * d;
        if (Math.sqrt(step) < 1e-6) break;
      } else {
        lambda = Math.min(lambda * 3, 1e7);
        if (lambda >= 1e7) break;
      }
    }
    for (let i = 0; i < k; i++) freeHinges[i].angle = theta[i];
  }

  // Fallback bbox if pattern-geom isn't present (it always is on /preview + in the test).
  function bboxNodes(nodes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of nodes) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
    if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }
  const round3 = (v) => Math.round(v * 1000) / 1000;

  window.PatternFold = { foldDoc };
})();
