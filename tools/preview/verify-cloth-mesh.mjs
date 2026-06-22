// verify-cloth-mesh.mjs — headless test for the M4 drape RENDERER (preview3d.drapeToGroup).
//
// Like verify-fold-mesh.mjs (which guards buildFoldedGroup), this exercises the render side that
// turns a settled cloth solve into a THREE.Group: it shims window with the pure pattern-geom +
// pattern-fold + poly2tri + pattern-mesh + pattern-cloth globals, imports preview3d.js (which
// imports 'three' via the resolver hook), runs solveDrape, and asserts the built group — one
// textured face mesh per piece with UVs + normals, a plausible inflated/floor-seated bbox, straps
// on a strap tote, no NaN, and the empty-input degradation. Textures are omitted (no DOM), so the
// geometry/placement path is identical and headless.
//
//   cd ~/sewingapp/tools/preview && node verify-cloth-mesh.mjs
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./three-resolver.mjs', import.meta.url);
const THREE = await import('three');

global.window = {};
const APP = '/home/ehill/sewingapp/app/static/js';
eval(readFileSync(`${APP}/vendor/poly2tri.js`, 'utf8'));
eval(readFileSync(`${APP}/pattern-geom.js`, 'utf8'));
eval(readFileSync(`${APP}/pattern-fold.js`, 'utf8'));
eval(readFileSync(`${APP}/pattern-mesh.js`, 'utf8'));
eval(readFileSync(`${APP}/pattern-cloth.js`, 'utf8'));
const F = global.window.PatternFold, Cl = global.window.PatternCloth;
const { drapeToGroup } = await import('../../app/static/js/preview3d.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const rect = (id, name, w, h) => ({ id, name, count: 1, seamMm: 0, cornerRadius: 0, closed: true,
  nodes: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] });
function tote(extra) {
  const pieces = [
    rect('p_base', 'Base', 300, 120), rect('p_front', 'Front', 300, 250), rect('p_back', 'Back', 300, 250),
    rect('p_sideL', 'Side L', 120, 250), rect('p_sideR', 'Side R', 120, 250),
  ];
  const seams = [
    { id: 's_bf', a: { piece: 'p_base', edge: 0 }, b: { piece: 'p_front', edge: 0 }, foldAngle: 90 },
    { id: 's_bb', a: { piece: 'p_base', edge: 2 }, b: { piece: 'p_back', edge: 0 }, foldAngle: 90 },
    { id: 's_bl', a: { piece: 'p_base', edge: 3 }, b: { piece: 'p_sideL', edge: 0 }, foldAngle: 90 },
    { id: 's_br', a: { piece: 'p_base', edge: 1 }, b: { piece: 'p_sideR', edge: 0 }, foldAngle: 90 },
    { id: 's_fl', a: { piece: 'p_front', edge: 3 }, b: { piece: 'p_sideL', edge: 3 }, foldAngle: null },
    { id: 's_fr', a: { piece: 'p_front', edge: 1 }, b: { piece: 'p_sideR', edge: 1 }, foldAngle: null },
    { id: 's_bkl', a: { piece: 'p_back', edge: 3 }, b: { piece: 'p_sideL', edge: 1 }, foldAngle: null },
    { id: 's_bkr', a: { piece: 'p_back', edge: 1 }, b: { piece: 'p_sideR', edge: 3 }, foldAngle: null },
  ];
  if (extra) { pieces.push(extra.piece); seams.push(...extra.seams); }
  return { pieces, seams };
}
const H = 25;

console.log('=== drape render: boxy tote (textured-less, per-piece faces) ===');
{
  const { pieces, seams } = tote();
  const res = Cl.solveDrape(pieces, seams, { h: H });
  const fold = F.foldDoc(pieces, seams);
  const g = drapeToGroup({ params: { pieces, seams } }, res, fold);
  g.updateMatrixWorld(true);
  ok(g.isObject3D, 'drapeToGroup returns an Object3D');
  const faces = []; g.traverse((o) => { if (o.userData && o.userData.kind === 'face') faces.push(o); });
  ok(faces.length === 5, `5 face meshes, one per piece (got ${faces.length})`);
  ok(faces.every((m) => m.geometry.attributes.position.count >= 3 && m.geometry.attributes.uv && m.geometry.attributes.normal), 'faces have position + uv + normals');
  ok(faces.every((m) => m.geometry.index && m.geometry.index.count % 3 === 0), 'faces are indexed triangles');
  // positions finite + sum to the full node set across faces (each node belongs to one piece)
  let finite = true, total = 0;
  for (const m of faces) { const p = m.geometry.attributes.position; total += p.count; for (let i = 0; i < p.count * 3; i++) if (!Number.isFinite(p.array[i])) finite = false; }
  ok(finite, 'all face vertex positions finite (no NaN)');
  ok(total === res.nodes.length, `face vertices cover every node (${total} = ${res.nodes.length})`);
  // bbox: a plausible inflated box sitting on the floor (min y ≈ 0)
  const box = new THREE.Box3().setFromObject(g);
  const sz = box.getSize(new THREE.Vector3());
  const dims = [sz.x, sz.y, sz.z].sort((a, b) => a - b);
  ok(dims[0] > 96 && dims[0] < 240 && dims[1] > 200 && dims[1] < 500 && dims[2] > 240 && dims[2] < 600,
    `bbox ≈ rounded W×H×D (sorted ${dims.map((d) => d.toFixed(0))})`);
  // the inflated base bows gently DOWNWARD (its outward normal points down), bounded by the
  // tether (~5% of the diagonal ≈ 20 mm) — so the lowest point dips a little below 0, never far.
  ok(box.min.y > -45 && box.min.y < 8, `rests near the floor on a rounded base (min y ${box.min.y.toFixed(1)})`);
  // mixed U orientation (some panels face inward → U-flipped, like the M3 fold)
  let flipped = 0, fwd = 0;
  for (const m of faces) {
    const p = m.geometry.attributes.position, u = m.geometry.attributes.uv;
    let lo = 0, hi = 0; for (let i = 1; i < p.count; i++) { if (p.getX(i) < p.getX(lo)) lo = i; if (p.getX(i) > p.getX(hi)) hi = i; }
    if (p.getX(hi) - p.getX(lo) < 1e-6) continue;
    (u.getX(hi) >= u.getX(lo) ? fwd++ : flipped++);
  }
  ok(flipped + fwd > 0, `panels carry a U orientation (${flipped} flipped, ${fwd} forward)`);
}

console.log('=== drape render: strap tote (one arched handle rides on top) ===');
{
  const strap = rect('p_strap', 'Strap', 550, 25); strap.count = 2;   // SPANS the two sides, cut ×2
  const { pieces, seams } = tote({ piece: strap, seams: [
    { id: 's1', a: { piece: 'p_strap', edge: 3 }, b: { piece: 'p_sideL', edge: 2 }, foldAngle: null },
    { id: 's2', a: { piece: 'p_strap', edge: 1 }, b: { piece: 'p_sideR', edge: 2 }, foldAngle: null },
  ] });
  const res = Cl.solveDrape(pieces, seams, { h: H });
  const fold = F.foldDoc(pieces, seams);
  const g = drapeToGroup({ params: { pieces, seams } }, res, fold);
  g.updateMatrixWorld(true);
  const faces = [], straps = []; g.traverse((o) => { if (!o.userData) return; if (o.userData.kind === 'face') faces.push(o); if (o.userData.kind === 'strap') straps.push(o); });
  ok(faces.length === 5, `5 bag faces (strap excluded from the sim), got ${faces.length}`);
  ok(straps.length === 1, `ONE arched handle (span ×2 → single handle, the bug fix), got ${straps.length}`);
  ok(straps.every((m) => m.geometry.attributes.position.count >= 6), 'strap band triangulated');
  const faceBox = new THREE.Box3(); faces.forEach((m) => faceBox.expandByObject(m));
  const strapBox = new THREE.Box3(); straps.forEach((m) => strapBox.expandByObject(m));
  ok(strapBox.max.y > faceBox.max.y, `handle arches above the bag top (${strapBox.max.y.toFixed(0)} > ${faceBox.max.y.toFixed(0)})`);
}

console.log('=== drape render: cached blob round-trips into the same group ===');
{
  const { pieces, seams } = tote();
  const res = Cl.solveDrape(pieces, seams, { h: H });
  const back = Cl.decodeDrape(Cl.encodeDrape(res));
  const g = drapeToGroup({ params: { pieces, seams } }, back, F.foldDoc(pieces, seams));
  const faces = []; g.traverse((o) => { if (o.userData && o.userData.kind === 'face') faces.push(o); });
  ok(faces.length === 5, `decoded cache renders 5 faces (got ${faces.length})`);
  let finite = true; for (const m of faces) { const p = m.geometry.attributes.position; for (let i = 0; i < p.count * 3; i++) if (!Number.isFinite(p.array[i])) finite = false; }
  ok(finite, 'decoded-cache faces finite');
}

console.log('=== degradation: empty solve → empty group (never throws/blanks) ===');
{
  const g = drapeToGroup({ params: { pieces: [] } }, { nodes: [], tris: [], pieceRanges: [], localUV: [] }, null);
  ok(g.isObject3D && g.children.length === 0, 'empty solve → empty group');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'SOME FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
