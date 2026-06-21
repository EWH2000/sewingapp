// preview.js — assembled 3D preview, page entry (M1).
//
// Fetches the saved pattern document and builds the sewn-up shape: for a boxy tote, an
// orbitable 3D box whose faces are textured with their pattern pieces, on a soft studio
// backdrop with a leather-tan handle and a "finished measurements" spec plate. Geometry/
// texturing live in preview3d.js (imports only 'three', so it stays headless-testable);
// this entry owns the scene, renderer, OrbitControls (touch), the doc fetch, and the overlay.
//
// The WebGL canvas is transparent (alpha) so the CSS studio gradient on .preview-stage
// shows through behind the bag.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { docToMesh, panelCanvasTexture, frameObject, contactShadow } from 'preview3d';

const BASE = window.SEWING_BASE || '';
const ident = window.SEWING_PREVIEW || {};
const UNIT = (() => { try { return localStorage.getItem('sewing.unit') || 'in'; } catch (_) { return 'in'; } })();
const uSuf = UNIT === 'cm' ? 'cm' : 'in';
const dim = (mm) => String(Math.round((UNIT === 'cm' ? mm / 10 : mm / 25.4) * 10) / 10);

const canvas = document.getElementById('preview-canvas');
const stage = document.getElementById('preview-stage');
const msgEl = document.getElementById('preview-msg');
const specEl = document.getElementById('pv-spec');
const specGrid = document.getElementById('pv-spec-grid');
const hintEl = document.getElementById('pv-hint');
const setMsg = (t) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.hidden = !t; } };
const show = (el, on) => { if (el) el.hidden = !on; };

if (!canvas || !stage) {
  console.error('[preview] missing #preview-canvas / #preview-stage');
} else {
  init();
}

async function init() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);   // transparent -> the CSS studio gradient shows through

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
  camera.position.set(600, 500, 900);    // frameObject overrides once the bag loads

  // Warm key + cool fill + subtle rim — depth and a calmer, studio look (not flat white).
  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x2a2f36, 0.9));
  const key = new THREE.DirectionalLight(0xfff1dd, 1.25); key.position.set(0.7, 1.3, 0.9); scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.55); fill.position.set(-1, 0.4, -0.6); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.35); rim.position.set(-0.5, 0.7, -1.2); scene.add(rim);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  // Fetch the full document (the route injects only id/name/kind — same as /edit).
  setMsg('Loading…');
  let pat = null;
  try {
    if (ident.id != null) {
      const r = await fetch(BASE + '/patterns/' + ident.id);
      if (r.ok) pat = await r.json();
    }
  } catch (e) { console.warn('[preview] fetch failed', e); }

  if (!pat) { setMsg('Could not load this pattern.'); return; }
  if (pat.kind !== 'box') {
    setMsg('3D preview supports boxy totes so far — garments and freeform shapes are coming.');
    return;
  }

  const group = docToMesh(pat, { makeTexture: (p) => panelCanvasTexture(p, UNIT) });
  scene.add(group);
  const sh = contactShadow(+pat.params.widthMm, +pat.params.depthMm);
  if (sh) scene.add(sh);
  frameObject(camera, controls, group, 1.35);
  resize();

  fillSpec(pat);
  setMsg(''); show(specEl, true); show(hintEl, true);
  console.log('[preview] box mesh ready:', pat.name);
}

// The "finished measurements" spec plate — the strap length lives here.
function fillSpec(pat) {
  if (!specGrid) return;
  const p = pat.params || {};
  const row = (k, v) => `<div class="pv-spec__row"><span class="pv-spec__k">${k}</span><span class="pv-spec__v">${v} <em>${uSuf}</em></span></div>`;
  let html = '';
  if (p.widthMm && p.heightMm && p.depthMm) html += row('Bag', `${dim(p.widthMm)} × ${dim(p.heightMm)} × ${dim(p.depthMm)}`);
  if (p.strapLenMm && p.strapWidthMm) html += row('Strap', `${dim(p.strapLenMm)} × ${dim(p.strapWidthMm)}`);
  specGrid.innerHTML = html;
}
