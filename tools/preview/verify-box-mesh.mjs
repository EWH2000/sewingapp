// verify-box-mesh.mjs — headless geometry test for M1's docToMesh (the box preview).
//
// preview3d.js imports only 'three'. A resolve hook (three-resolver.mjs) points that bare
// specifier at this dir's pinned three (same version vendored into the app), since Node
// would otherwise resolve it relative to preview3d.js's own dir (no node_modules there).
// We then assert the pure panel layout and the real docToMesh group dimensions WITHOUT a
// DOM (no textures: makeTexture is omitted, so the geometry path is identical and headless).
//
//   cd ~/sewingapp/tools/preview && npm install && node verify-box-mesh.mjs

import { register } from 'node:module';
import assert from 'node:assert';

register('./three-resolver.mjs', import.meta.url);
const THREE = await import('three');
const { boxPanelsFromParams, docToMesh } = await import('../../app/static/js/preview3d.js');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ok:', msg); pass++; };
const close = (a, b, t = 0.01) => Math.abs(a - b) <= t;

const params = { widthMm: 356, heightMm: 381, depthMm: 152, seamMm: 10, strapLenMm: 635, strapWidthMm: 38 };
const W = 356, H = 381, D = 152;

console.log('=== pure panel layout (boxPanelsFromParams) ===');
const panels = boxPanelsFromParams(params);
ok(panels.length === 5, '5 panels (open-top tote: 4 walls + base)');
const by = (r) => panels.find((p) => p.role === r);
ok(close(by('front').wMm, W) && close(by('front').hMm, H), 'front = W×H');
ok(close(by('back').wMm, W) && close(by('back').hMm, H), 'back = W×H');
ok(close(by('left').wMm, D) && close(by('left').hMm, H), 'left = D×H');
ok(close(by('right').wMm, D) && close(by('right').hMm, H), 'right = D×H');
ok(close(by('base').wMm, W) && close(by('base').hMm, D), 'base = W×D');
ok(close(by('base').pos[1], 0), 'base sits on the floor (y=0)');
ok(close(by('front').pos[2], D / 2) && close(by('back').pos[2], -D / 2), 'front/back at ±D/2');
ok(close(by('right').pos[0], W / 2) && close(by('left').pos[0], -W / 2), 'sides at ±W/2');

console.log('=== docToMesh group (no textures -> headless) ===');
const g = docToMesh({ kind: 'box', params });
g.updateMatrixWorld(true);
ok(g.isObject3D, 'docToMesh returns an Object3D');
const panelMeshes = [];
g.traverse((o) => { if (o.userData && o.userData.kind === 'panel') panelMeshes.push(o); });
ok(panelMeshes.length === 5, 'group has 5 panel meshes');
const box = new THREE.Box3();
panelMeshes.forEach((m) => box.expandByObject(m));
const s = box.getSize(new THREE.Vector3());
ok(close(s.x, W, 0.5) && close(s.y, H, 0.5) && close(s.z, D, 0.5),
   `panel bbox = ${W}×${H}×${D}  (got ${s.x.toFixed(1)}×${s.y.toFixed(1)}×${s.z.toFixed(1)})`);
ok(close(box.min.y, 0, 0.5) && close(box.max.y, H, 0.5), 'box spans y ∈ [0, H]');
ok(close(box.min.x, -W / 2, 0.5) && close(box.max.x, W / 2, 0.5), 'box spans x ∈ [-W/2, W/2]');
ok(close(box.min.z, -D / 2, 0.5) && close(box.max.z, D / 2, 0.5), 'box spans z ∈ [-D/2, D/2]');

const straps = [];
g.traverse((o) => { if (o.userData && o.userData.kind === 'strap') straps.push(o); });
ok(straps.length === 2, '2 strap handles present');
const full = new THREE.Box3().setFromObject(g);
ok(full.max.y > H, 'straps arch above the box top');

console.log('=== graceful degradation ===');
const g2 = docToMesh({ kind: 'freeform', params: { pieces: [] } });
ok(g2.isObject3D && g2.children.length === 0, 'unsupported kind -> empty group (never throws/blanks)');

console.log(`\nALL PASS — ${pass} checks`);
