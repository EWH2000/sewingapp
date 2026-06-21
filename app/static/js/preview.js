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
import { docToMesh, panelCanvasTexture, pieceFaceTexture, frameObject, contactShadow } from 'preview3d';

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
const floorEl = document.getElementById('pv-floor-wrap');
const setMsg = (t) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.hidden = !t; } };
const show = (el, on) => { if (el) el.hidden = !on; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

  // ── box (M1): the parametric boxy tote — unchanged ──
  if (pat.kind === 'box') {
    const group = docToMesh(pat, { makeTexture: (p) => panelCanvasTexture(p, UNIT) });
    scene.add(group);
    const sh = contactShadow(+pat.params.widthMm, +pat.params.depthMm);
    if (sh) scene.add(sh);
    frameObject(camera, controls, group, 1.35);
    resize();
    fillSpec(pat);
    setMsg(''); show(specEl, true); show(hintEl, true);
    console.log('[preview] box mesh ready:', pat.name);
    return;
  }

  // ── freeform WITH a seam graph (M3): fold it up ──
  const seams = pat.params && pat.params.seams;
  if (pat.kind === 'freeform' && Array.isArray(seams) && seams.length) {
    if (!window.PatternFold) { setMsg('The 3D fold engine didn’t load — try reloading the page.'); return; }
    let foldGroup = null, foldShadow = null;
    const buildFold = () => {
      if (foldGroup) { scene.remove(foldGroup); foldGroup = null; }
      if (foldShadow) { scene.remove(foldShadow); foldShadow = null; }
      const group = docToMesh(pat, { makeTexture: (p) => pieceFaceTexture(p, UNIT) });
      if (!group.children.length) {
        setMsg(group.userData.foldError
          ? 'Could not fold this pattern (the seams may not form a foldable shape).'
          : 'Add seams in Sew mode to fold this pattern in 3D.');
        return;
      }
      scene.add(group); foldGroup = group;
      const bb = new THREE.Box3().setFromObject(group);
      const sz = bb.getSize(new THREE.Vector3());
      const sh = contactShadow(sz.x, sz.z);
      if (sh) { sh.position.y = bb.min.y - 2; scene.add(sh); foldShadow = sh; }
      frameObject(camera, controls, group, 1.4);
      resize();
      fillFoldSpec(pat, group.userData.fold);
      setMsg(''); show(specEl, true); show(hintEl, true);
      console.log('[preview] fold ready:', pat.name, group.userData.fold);
    };
    buildFold();
    setupFloorControl(pat, buildFold);
    return;
  }

  // ── freeform without seams, or other kinds ──
  setMsg(pat.kind === 'freeform'
    ? 'No seams yet — open this pattern in Sew mode and join edges to fold it in 3D.'
    : '3D preview supports boxy totes and folded freeform pieces so far — garments are coming.');
}

// The fold readout: piece count + whether the bag closes (and by how much if not).
function fillFoldSpec(pat, fold) {
  if (!specGrid || !fold) return;
  const row = (k, v) => `<div class="pv-spec__row"><span class="pv-spec__k">${k}</span><span class="pv-spec__v">${v}</span></div>`;
  const gaps = (fold.closures || []).map((c) => c.gapMm).filter((g) => g != null);
  const maxGap = gaps.length ? Math.max.apply(null, gaps) : 0;
  let line;
  if (fold.mode === 'closed') line = maxGap < 0.5 ? 'Closes cleanly' : `Closes within ${maxGap.toFixed(1)} mm`;
  else if (fold.mode === 'open') line = `Open by ${maxGap.toFixed(1)} mm — needs easing`;
  else line = 'Partial fold (tree only)';
  specGrid.innerHTML = row('Pieces', String(fold.pieceCount)) + row('Assembly', line);
}

// The "Floor piece" override — auto-detect can pick wrong (a tall tote's largest panel is a
// wall, not the base); this lets her choose which piece lies flat. Persists an additive
// `foldRoot` hint via the normal save (the tiler ignores it — the print spine is untouched).
function setupFloorControl(pat, rebuild) {
  const sel = document.getElementById('pv-floor');
  if (!sel || !floorEl) return;
  const pieces = (pat.params && pat.params.pieces) || [];
  sel.innerHTML = '<option value="">Floor: auto</option>'
    + pieces.map((p) => `<option value="${esc(p.id)}">Floor: ${esc(p.name || p.id)}</option>`).join('');
  sel.value = pat.params.foldRoot || '';
  show(floorEl, true);
  sel.onchange = async () => {
    pat.params.foldRoot = sel.value || null;
    rebuild();
    try {
      await fetch(BASE + '/patterns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pat.id, name: pat.name, kind: pat.kind, params: pat.params }),
      });
    } catch (e) { console.warn('[preview] could not save floor choice', e); }
  };
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
