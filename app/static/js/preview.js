// preview.js — assembled 3D preview, M0 (the loader spike).
//
// Goal of M0: prove the no-build three.js import-map delivery path renders and
// touch-orbits on the iPad. A hardcoded cube, zero pattern geometry, zero physics.
// M1 will extract the scene + a real docToMesh() into a sibling preview3d.js and
// texture each face with the pattern outline; for now everything lives here so there
// is no relative ESM import (and thus no addon-style cache wrinkle) to debug.
//
// three.js is real ESM, imported by name via the page's import map — there is
// deliberately NO window.THREE shim (that classic-bundle pattern is only for Maker.js).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const doc = window.SEWING_PREVIEW || {};   // id/name/kind only in M0; the cube ignores it.

const canvas = document.getElementById('preview-canvas');
const stage = document.getElementById('preview-stage');
if (!canvas || !stage) {
  console.error('[preview] missing #preview-canvas / #preview-stage');
} else {
  start();
}

function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1d21);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(2.6, 2.0, 3.6);

  // Lighting: hemisphere fill + a directional key, so the cube's faces shade
  // differently as you orbit — that shading change is the visible proof of 3D.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 6, 3);
  scene.add(key);

  // The cube — house accent colour, with crisp edge outlines so rotation is unmistakable.
  const geo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  const cube = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xe0653a, roughness: 0.55, metalness: 0.0 }),
  );
  scene.add(cube);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0xfdfdfb }),
  );
  cube.add(edges);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;     // smooth touch orbit
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);   // false: CSS owns the canvas size; we set only the drawing buffer
  }
  resize();
  // ResizeObserver catches orientation changes + the stage's dvh-based height; window
  // resize is the belt-and-suspenders fallback for older WebKit.
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  console.log('[preview] M0 cube ready', doc && doc.name ? `(pattern: ${doc.name})` : '');
}
