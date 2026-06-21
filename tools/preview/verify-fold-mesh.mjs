// verify-fold-mesh.mjs — headless test for the M3 fold RENDERER (preview3d.js freeform path).
//
// Unlike verify-fold.mjs (pure solver), this exercises docToMesh's freeform branch: it shims
// window with the pure pattern-geom + pattern-fold globals, imports preview3d.js (which imports
// 'three' via the resolver hook), and asserts the built THREE.Group — face count, closed-box
// bbox, on-the-floor seating, and the no-seams degradation. Textures are omitted (no DOM), so
// the geometry/placement path is identical and headless.
//
//   cd ~/sewingapp/tools/preview && node verify-fold-mesh.mjs
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./three-resolver.mjs', import.meta.url);
const THREE = await import('three');

// pure modules as window globals (the same channel the browser uses); no DOM, no textures.
global.window = {};
const ROOT = '/home/ehill/sewingapp/app/static/js';
eval(readFileSync(`${ROOT}/pattern-geom.js`, 'utf8'));
eval(readFileSync(`${ROOT}/pattern-fold.js`, 'utf8'));

const { docToMesh } = await import('../../app/static/js/preview3d.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const close = (a, b, t = 0.6) => Math.abs(a - b) <= t;
const rect = (id, name, w, h) => ({ id, name, nodes: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] });

console.log('=== freeform fold render: square open box ===');
const s = 100;
const params = {
  kind: 'freeform',
  pieces: [rect('base', 'Base', s, s), rect('front', 'Front', s, s), rect('back', 'Back', s, s), rect('sideL', 'L', s, s), rect('sideR', 'R', s, s)],
  seams: [
    { id: 't_bf', a: { piece: 'base', edge: 0 }, b: { piece: 'front', edge: 0 }, foldAngle: null },
    { id: 't_bb', a: { piece: 'base', edge: 2 }, b: { piece: 'back', edge: 0 }, foldAngle: null },
    { id: 't_bl', a: { piece: 'base', edge: 3 }, b: { piece: 'sideL', edge: 0 }, foldAngle: null },
    { id: 't_br', a: { piece: 'base', edge: 1 }, b: { piece: 'sideR', edge: 0 }, foldAngle: null },
    { id: 'c_fl', a: { piece: 'front', edge: 3 }, b: { piece: 'sideL', edge: 3 }, foldAngle: null },
    { id: 'c_fr', a: { piece: 'front', edge: 1 }, b: { piece: 'sideR', edge: 1 }, foldAngle: null },
    { id: 'c_bl', a: { piece: 'back', edge: 3 }, b: { piece: 'sideL', edge: 1 }, foldAngle: null },
    { id: 'c_br', a: { piece: 'back', edge: 1 }, b: { piece: 'sideR', edge: 3 }, foldAngle: null },
  ],
};
const g = docToMesh({ kind: 'freeform', params });
g.updateMatrixWorld(true);
ok(g.isObject3D, 'docToMesh returns an Object3D');
const faces = [];
g.traverse((o) => { if (o.userData && o.userData.kind === 'face') faces.push(o); });
ok(faces.length === 5, `5 face meshes (got ${faces.length})`);
ok(g.userData.fold && g.userData.fold.mode === 'closed', `fold mode = closed (got ${g.userData.fold && g.userData.fold.mode})`);
ok(g.userData.fold && g.userData.fold.cycles === 4, `cycles = 4 (got ${g.userData.fold && g.userData.fold.cycles})`);
const box = new THREE.Box3().setFromObject(g);
const sz = box.getSize(new THREE.Vector3());
ok(close(sz.x, 100) && close(sz.y, 100) && close(sz.z, 100), `box bbox ≈ 100³ (got ${sz.x.toFixed(1)}×${sz.y.toFixed(1)}×${sz.z.toFixed(1)})`);
ok(close(box.min.y, 0), `sits on the floor (min y ≈ 0, got ${box.min.y.toFixed(2)})`);
// each face mesh has UVs (texture registration) and a non-empty triangulation
ok(faces.every((m) => m.geometry.attributes.uv && m.geometry.attributes.position.count >= 3), 'faces triangulated with UVs');
// text-direction fix: panels facing INTO the bag get their texture-U flipped, so a box
// shows a MIX of U orientations (front reads forward, inward panels are flipped → not all same).
let flipped = 0, fwd = 0;
for (const m of faces) {
  const p = m.geometry.attributes.position, u = m.geometry.attributes.uv;
  let lo = 0, hi = 0;
  for (let i = 1; i < p.count; i++) { if (p.getX(i) < p.getX(lo)) lo = i; if (p.getX(i) > p.getX(hi)) hi = i; }
  if (p.getX(hi) - p.getX(lo) < 1e-6) continue;
  (u.getX(hi) >= u.getX(lo) ? fwd++ : flipped++);
}
ok(flipped > 0 && fwd > 0, `inward panels U-flipped (mixed orientation: ${flipped} flipped, ${fwd} forward)`);

console.log('=== freeform fold render: bag with a strap (arched handle) ===');
const paramsS = {
  kind: 'freeform',
  pieces: [
    rect('base', 'Base', s, s), rect('front', 'Front', s, s), rect('back', 'Back', s, s),
    rect('sideL', 'L', s, s), rect('sideR', 'R', s, s),
    { ...rect('strap', 'Strap', 300, 20), count: 2 },   // long thin band, cut ×2
  ],
  seams: [
    ...params.seams,   // the 8 box seams
    { id: 's_strap_l', a: { piece: 'strap', edge: 1 }, b: { piece: 'front', edge: 2 }, foldAngle: null },
    { id: 's_strap_r', a: { piece: 'strap', edge: 3 }, b: { piece: 'front', edge: 2 }, foldAngle: null },
  ],
};
const gs = docToMesh({ kind: 'freeform', params: paramsS });
gs.updateMatrixWorld(true);
const sfaces = [], sstraps = [], sgaps = [];
gs.traverse((o) => {
  if (!o.userData) return;
  if (o.userData.kind === 'face') sfaces.push(o);
  if (o.userData.kind === 'strap') sstraps.push(o);
  if (o.userData.kind === 'gap-seam') sgaps.push(o);
});
ok(sfaces.length === 5, `5 bag faces (strap excluded from faces), got ${sfaces.length}`);
ok(sstraps.length >= 1, `at least one strap band mesh, got ${sstraps.length}`);
ok(sstraps.every((m) => m.geometry.attributes.position.count >= 6), 'strap band triangulated');
ok(gs.userData.fold && gs.userData.fold.mode === 'closed', `bag still closed, got ${gs.userData.fold && gs.userData.fold.mode}`);
ok(sgaps.length === 0, 'no gap-seams (the strap did not degrade the bag)');
const faceBox = new THREE.Box3(); sfaces.forEach((m) => faceBox.expandByObject(m));
const strapBox = new THREE.Box3(); sstraps.forEach((m) => strapBox.expandByObject(m));
ok(strapBox.max.y > faceBox.max.y, `strap arches above the bag top (${strapBox.max.y.toFixed(0)} > ${faceBox.max.y.toFixed(0)})`);

console.log('=== degradation: freeform without seams ===');
const g2 = docToMesh({ kind: 'freeform', params: { pieces: [rect('a', 'A', 10, 10)], seams: [] } });
ok(g2.isObject3D && g2.children.length === 0, 'no-seams freeform -> empty group (never throws/blanks)');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'SOME FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
