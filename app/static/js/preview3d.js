// preview3d.js — M1 box preview: docToMesh + per-face pattern texturing.
//
// Imports ONLY 'three' (no addons) so the headless test tools/preview/verify-box-mesh.mjs
// can `import` it in Node, where 'three' resolves from node_modules. The scene/renderer
// and OrbitControls live in preview.js (the page entry). `document` and window.PatternGeom
// are touched ONLY inside panelCanvasTexture (browser-only, never at module top level), so
// docToMesh/boxPanelsFromParams run fine under Node with no DOM.
//
// Coordinate convention: a y-up world in millimetres, base on the floor (y=0). The camera
// frames the mm box directly (no unit rescale) — frameObject sets near/far from the fit
// distance, so the large magnitudes are fine.

import * as THREE from 'three';

const LEATHER = 0xb27c4f;   // strap — muted saddle-tan (real tote-handle material), calmer than the house orange
const PAPER = '#fdfdfb', INK = '#1b1d21', SEAMC = '#1f9d6b', GRAINC = '#6b7079';

// Display units (the geometry is always mm). Default inches; cm is the alternative.
const fmtDim = (mm, unit) => String(Math.round((unit === 'cm' ? mm / 10 : mm / 25.4) * 10) / 10);
const unitSuffix = (unit) => (unit === 'cm' ? 'cm' : 'in');

// ── pure: open-top boxy-tote panel layout in millimetres (no THREE, no DOM) ───────────
// Front/back span W×H; the two sides span D×H; the base spans W×D. Returns each panel's
// plane size, the Euler rotation that orients it outward, and its center.
export function boxPanelsFromParams(params) {
  const W = +params.widthMm, H = +params.heightMm, D = +params.depthMm;
  const sa = +params.seamMm || 0;
  return [
    { role: 'front', label: 'Front', wMm: W, hMm: H, seamMm: sa, pos: [0, H / 2, D / 2],  rot: [0, 0, 0] },
    { role: 'back',  label: 'Back',  wMm: W, hMm: H, seamMm: sa, pos: [0, H / 2, -D / 2], rot: [0, Math.PI, 0] },
    { role: 'right', label: 'Side',  wMm: D, hMm: H, seamMm: sa, pos: [W / 2, H / 2, 0],  rot: [0, Math.PI / 2, 0] },
    { role: 'left',  label: 'Side',  wMm: D, hMm: H, seamMm: sa, pos: [-W / 2, H / 2, 0], rot: [0, -Math.PI / 2, 0] },
    { role: 'base',  label: 'Base',  wMm: W, hMm: D, seamMm: sa, pos: [0, 0, 0],          rot: [-Math.PI / 2, 0, 0] },
  ];
}

// A flat ribbon (rectangular cross-section, lying in the curve's z-plane) following `curve`,
// `widthMm` wide — a strap band. Broad faces point ±z; DoubleSide lights both.
function strapRibbonGeometry(curve, widthMm, samples = 48) {
  const pts = curve.getSpacedPoints(samples);
  const n = pts.length, half = widthMm / 2, pos = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const wx = ty, wy = -tx;     // in-plane normal = band width direction (z stays constant)
    pos.push(p.x + wx * half, p.y + wy * half, p.z, p.x - wx * half, p.y - wy * half, p.z);
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) { const o = i * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  return geo;
}

// ── docToMesh: build a THREE.Group from a pattern document (browser + Node) ────────────
// opts.makeTexture(panel) -> THREE.Texture|null. When omitted (Node tests), panels get a
// plain paper material — the geometry/scene-graph is identical, so the headless test
// asserts on dimensions/bbox without a DOM. Degrades to an empty group for kinds it can't
// build yet (never throws / blanks).
export function docToMesh(pattern, opts = {}) {
  const params = (pattern && pattern.params) || pattern || {};
  const kind = (pattern && pattern.kind) || (params.widthMm != null && params.depthMm != null ? 'box' : null);
  const group = new THREE.Group();
  group.name = 'pattern';
  if (kind !== 'box') {
    // Freeform doc WITH a seam graph → fold it up (M3). Guarded so the box path and the
    // headless Node test (no window/PatternFold) fall straight through to an empty group.
    const PF = (typeof window !== 'undefined') && window.PatternFold;
    if (kind === 'freeform' && PF && params.seams && params.seams.length && params.pieces && params.pieces.length)
      return buildFoldedGroup(group, params, opts);
    group.userData.unsupported = kind || 'unknown';
    return group;
  }

  const make = opts.makeTexture;
  for (const p of boxPanelsFromParams(params)) {
    const geo = new THREE.PlaneGeometry(p.wMm, p.hMm);
    const tex = make ? make(p) : null;
    const mat = tex
      ? new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 })
      : new THREE.MeshStandardMaterial({ color: 0xf3efe7, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.pos[0], p.pos[1], p.pos[2]);
    m.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
    m.userData.kind = 'panel'; m.userData.role = p.role; m.name = 'panel:' + p.role;
    group.add(m);
  }

  // Straps — flat rectangular bands (like real tote webbing/leather), NOT round tubes. The
  // band width = strapWidthMm and the arch's ARC LENGTH ≈ strapLenMm (control height
  // binary-searched), so a longer strap visibly rises higher. A shape cue, not the textured
  // strap pattern piece; Step 2/3 will replace these with the actual sewn strap geometry.
  const W = +params.widthMm, H = +params.heightMm, D = +params.depthMm;
  const L = +params.strapLenMm || 0, sw = +params.strapWidthMm || 0;
  if (L > 0 && sw > 0) {
    const spanHalf = Math.min(W * 0.28, Math.max(20, (W - 40) / 2));   // half the attach span on the top edge
    const strapMat = new THREE.MeshStandardMaterial({ color: LEATHER, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.05 });
    const archFor = (z) => {
      const make = (c) => new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-spanHalf, H, z),
        new THREE.Vector3(0, H + c, z),
        new THREE.Vector3(spanHalf, H, z));
      let lo = 0, hi = Math.max(L * 2, 50);
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (make(mid).getLength() < L) lo = mid; else hi = mid; }
      return make((lo + hi) / 2);
    };
    for (const z of [D / 2, -D / 2]) {
      const band = new THREE.Mesh(strapRibbonGeometry(archFor(z), sw), strapMat);
      band.userData.kind = 'strap';
      group.add(band);
    }
  }

  group.updateMatrixWorld(true);
  return group;
}

// ── buildFoldedGroup: fold a freeform doc's pieces into 3D (M3) ────────────────────────
// Calls window.PatternFold.foldDoc (pure, headless) for absolute per-piece transforms, then
// builds a textured polygon per piece placed by its {pos,quat}. The mesh outline uses the
// AUTHORED nodes (so adjacent folded faces share the exact hinge edge); the texture uses the
// flattened cut (fillets/seam) — both framed by the same authored-nodes bbox so they register.
// Never throws/blanks: a solver error or empty result yields an empty group + userData flags.
function buildFoldedGroup(group, params, opts) {
  let fold;
  try { fold = window.PatternFold.foldDoc(params.pieces, params.seams, { root: params.foldRoot || null }); }
  catch (e) { group.userData.foldError = String((e && e.message) || e); return group; }
  group.userData.fold = { mode: fold.mode, closures: fold.closures, root: fold.root, cycles: fold.cycles, pieceCount: params.pieces.length };

  const G = (typeof window !== 'undefined') && window.PatternGeom;
  const make = opts.makeTexture;

  // Each panel is a double-sided plane. For panels whose textured front (+Z) face points
  // INTO the bag, the outside view is the BACK face → the pattern reads mirror-reversed. So
  // compute each panel's outward orientation (its world center vs the bag center) and flip
  // the texture U for inward-facing panels, so every panel reads correctly from outside.
  const qOf = (T) => new THREE.Quaternion(T.quat[0], T.quat[1], T.quat[2], T.quat[3]);
  const centerOf = (pc, T) => {
    let mx = 0, my = 0; for (const nd of pc.nodes) { mx += nd.x; my += nd.y; }
    return new THREE.Vector3(mx / pc.nodes.length, my / pc.nodes.length, 0)
      .applyQuaternion(qOf(T)).add(new THREE.Vector3(T.pos[0], T.pos[1], T.pos[2]));
  };
  const bag = new THREE.Vector3(); let nc = 0;
  for (const pc of params.pieces) { const T = fold.transforms[pc.id]; if (T && pc.nodes && pc.nodes.length >= 3) { bag.add(centerOf(pc, T)); nc++; } }
  if (nc) bag.multiplyScalar(1 / nc);

  for (const pc of params.pieces) {
    const T = fold.transforms[pc.id];
    if (!T || !pc.nodes || pc.nodes.length < 3) continue;
    const shape = new THREE.Shape();
    shape.moveTo(pc.nodes[0].x, pc.nodes[0].y);
    for (let i = 1; i < pc.nodes.length; i++) shape.lineTo(pc.nodes[i].x, pc.nodes[i].y);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);     // earcut — handles non-convex panels
    const bb = G && G.bbox ? G.bbox(pc.nodes) : localBbox(pc.nodes);
    const facesOut = new THREE.Vector3(0, 0, 1).applyQuaternion(qOf(T)).dot(centerOf(pc, T).sub(bag)) >= 0;
    const pos = geo.attributes.position, uv = [];
    for (let i = 0; i < pos.count; i++) {
      const u = (pos.getX(i) - bb.minX) / (bb.w || 1);
      uv.push(facesOut ? u : 1 - u, (pos.getY(i) - bb.minY) / (bb.h || 1));
    }
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const tex = make ? make(pc) : null;
    const mat = tex
      ? new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 })
      : new THREE.MeshStandardMaterial({ color: 0xf3efe7, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
    const m = new THREE.Mesh(geo, mat);
    m.quaternion.set(T.quat[0], T.quat[1], T.quat[2], T.quat[3]);
    m.position.set(T.pos[0], T.pos[1], T.pos[2]);
    m.userData.kind = 'face'; m.userData.pieceId = pc.id; m.name = 'face:' + pc.id;
    group.add(m);
  }
  if (fold.mode !== 'closed') addGapSeams(group, params, fold);
  group.updateMatrixWorld(true);
  return group;
}

// Dashed "this seam doesn't close" bridges for unclosed closure seams (mode open/tree).
function addGapSeams(group, params, fold) {
  const place = (T, n) => new THREE.Vector3(n.x, n.y, 0)
    .applyQuaternion(new THREE.Quaternion(T.quat[0], T.quat[1], T.quat[2], T.quat[3]))
    .add(new THREE.Vector3(T.pos[0], T.pos[1], T.pos[2]));
  const byId = {}; (params.pieces || []).forEach((p) => { byId[p.id] = p; });
  const seg = [];
  for (const c of fold.closures || []) {
    if (c.gapMm == null || c.gapMm < 0.5) continue;
    const s = (params.seams || []).find((x) => x.id === c.seam); if (!s) continue;
    const A = byId[s.a.piece], B = byId[s.b.piece], TA = fold.transforms[s.a.piece], TB = fold.transforms[s.b.piece];
    if (!A || !B || !TA || !TB) continue;
    const a0 = place(TA, A.nodes[s.a.edge]), a1 = place(TA, A.nodes[(s.a.edge + 1) % A.nodes.length]);
    const b0 = place(TB, B.nodes[s.b.edge]), b1 = place(TB, B.nodes[(s.b.edge + 1) % B.nodes.length]);
    // bridge by the nearer endpoint pairing (shows the "unzipped" gap clearly)
    if (a0.distanceTo(b1) + a1.distanceTo(b0) < a0.distanceTo(b0) + a1.distanceTo(b1)) seg.push(a0, b1, a1, b0);
    else seg.push(a0, b0, a1, b1);
  }
  if (!seg.length) return;
  const line = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(seg),
    new THREE.LineDashedMaterial({ color: 0xff5a3c, dashSize: 7, gapSize: 5, transparent: true, opacity: 0.95 }));
  line.computeLineDistances();        // required or LineDashedMaterial renders solid
  line.userData.kind = 'gap-seam';
  group.add(line);
}

const localBbox = (nodes) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of nodes) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  if (!isFinite(minX)) minX = minY = maxX = maxY = 0;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
};

// ── panelCanvasTexture: render a panel's flattened pattern outline to a CanvasTexture ──
// Browser-only (uses document + the classic window.PatternGeom for the SAME flatten the
// printer uses). Reused verbatim by Steps 2–3 — only WHERE the textured panel lands changes.
export function panelCanvasTexture(panel, unit = 'in') {
  if (typeof document === 'undefined') return null;
  const G = (typeof window !== 'undefined') && window.PatternGeom;
  const w = panel.wMm, h = panel.hMm;
  const ppm = Math.max(1.5, Math.min(1024 / Math.max(w, h), 6));   // px per mm, capped
  const cw = Math.max(8, Math.round(w * ppm)), ch = Math.max(8, Math.round(h * ppm));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const X = (x) => x * ppm, Y = (y) => (h - y) * ppm;             // flip y: pattern y-up -> canvas y-down

  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, cw, ch);

  // Flatten via G.pieceGeom (fillets/seam through Maker.js) when available; else a plain rect.
  let cut = null, seam = null;
  if (G && G.rectPiece && G.pieceGeom) {
    const piece = G.rectPiece(panel.label, w, h);
    piece.seamMm = panel.seamMm || 0; piece.closed = true; piece.cornerRadius = piece.cornerRadius || 0;
    try { const g = G.pieceGeom(piece); cut = g.cut; seam = g.seam; } catch (_) { /* fall back below */ }
  }
  if (!cut) cut = [[0, 0], [w, 0], [w, h], [0, h], [0, 0]];

  const poly = (pts, stroke, width, dash) => {
    if (!pts || !pts.length) return;
    ctx.beginPath(); ctx.setLineDash(dash || []);
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.lineWidth = width; ctx.strokeStyle = stroke; ctx.stroke(); ctx.setLineDash([]);
  };
  poly(cut, INK, Math.max(2, ppm * 1.2));
  if (seam) poly(seam, SEAMC, Math.max(1.5, ppm * 0.8), [ppm * 3, ppm * 2]);

  // grainline — vertical center with arrowheads
  ctx.strokeStyle = GRAINC; ctx.lineWidth = Math.max(1.5, ppm * 0.6);
  const gx = X(w / 2), gy0 = Y(h * 0.12), gy1 = Y(h * 0.88), a = Math.max(5, ppm * 5);
  ctx.beginPath(); ctx.moveTo(gx, gy0); ctx.lineTo(gx, gy1);
  ctx.moveTo(gx - a, gy0 + a); ctx.lineTo(gx, gy0); ctx.lineTo(gx + a, gy0 + a);
  ctx.moveTo(gx - a, gy1 - a); ctx.lineTo(gx, gy1); ctx.lineTo(gx + a, gy1 - a);
  ctx.stroke();

  // label — piece name + finished dimensions
  const fs = Math.max(12, Math.min(cw, ch) * 0.09);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = INK; ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(panel.label, cw / 2, ch / 2 - fs * 0.35);
  ctx.fillStyle = GRAINC; ctx.font = `${fs * 0.7}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(`${fmtDim(w, unit)} × ${fmtDim(h, unit)} ${unitSuffix(unit)}`, cw / 2, ch / 2 + fs * 0.7);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ── pieceFaceTexture: like panelCanvasTexture but for an ARBITRARY freeform piece ──────
// Draws the piece's true flattened outline (G.pieceGeom — fillets/seam) over its authored-
// nodes bbox, the SAME frame buildFoldedGroup uses for the mesh UVs, so the pattern registers
// exactly on the folded polygon. Browser-only (canvas + window.PatternGeom).
export function pieceFaceTexture(piece, unit = 'in') {
  if (typeof document === 'undefined') return null;
  const G = (typeof window !== 'undefined') && window.PatternGeom;
  if (!G || !piece || !piece.nodes || piece.nodes.length < 3) return null;
  const bb = G.bbox(piece.nodes);
  const w = bb.w || 1, h = bb.h || 1;
  const ppm = Math.max(1.5, Math.min(1024 / Math.max(w, h), 6));
  const cw = Math.max(8, Math.round(w * ppm)), ch = Math.max(8, Math.round(h * ppm));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const X = (x) => (x - bb.minX) * ppm, Y = (y) => (h - (y - bb.minY)) * ppm;   // y-up -> canvas y-down

  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, cw, ch);
  let cut = null, seam = null;
  try { const g = G.pieceGeom(piece); cut = g.cut; seam = g.seam; } catch (_) { /* fall back below */ }
  if (!cut) { cut = piece.nodes.map((n) => [n.x, n.y]); cut.push([piece.nodes[0].x, piece.nodes[0].y]); }

  const poly = (pts, stroke, width, dash) => {
    if (!pts || !pts.length) return;
    ctx.beginPath(); ctx.setLineDash(dash || []);
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.lineWidth = width; ctx.strokeStyle = stroke; ctx.stroke(); ctx.setLineDash([]);
  };
  poly(cut, INK, Math.max(2, ppm * 1.2));
  if (seam) poly(seam, SEAMC, Math.max(1.5, ppm * 0.8), [ppm * 3, ppm * 2]);

  const fs = Math.max(12, Math.min(cw, ch) * 0.12);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = INK; ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(piece.name || 'Piece', cw / 2, ch / 2 - fs * 0.35);
  ctx.fillStyle = GRAINC; ctx.font = `${fs * 0.7}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(`${fmtDim(w, unit)} × ${fmtDim(h, unit)} ${unitSuffix(unit)}`, cw / 2, ch / 2 + fs * 0.7);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

// ── frameObject: aim + distance the camera so `obj` fits, orbit target at its center ──
export function frameObject(camera, controls, obj, fitOffset = 1.35) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z) || 1;
  const fitH = maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360));
  const fitW = fitH / Math.max(camera.aspect, 0.0001);
  const dist = fitOffset * Math.max(fitH, fitW);
  const dir = new THREE.Vector3(0.9, 0.55, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 0.1);
  camera.far = dist * 1000;
  camera.updateProjectionMatrix();
  if (controls) { controls.target.copy(center); controls.update(); }
}

// ── contactShadow: a soft fake shadow (radial-gradient quad) to seat the bag ───────────
// Browser-only (canvas). Add it to the scene separately so it doesn't affect camera framing.
export function contactShadow(footWmm, footDmm) {
  if (typeof document === 'undefined') return null;
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.42)'); g.addColorStop(0.55, 'rgba(0,0,0,0.16)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry((footWmm || 200) * 1.6, (footDmm || 200) * 1.9),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = -2; m.renderOrder = -1; m.userData.kind = 'shadow';
  return m;
}
