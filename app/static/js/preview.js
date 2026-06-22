// preview.js — assembled 3D preview, page entry (M1 box · M3 fold · M4 inflated drape).
//
// Fetches the saved pattern document and builds the sewn-up shape:
//   • box (parametric boxy tote) — an orbitable textured box (M1).
//   • freeform + seams — the DEFAULT view is the M4 INFLATED DRAPE (a hand-rolled XPBD cloth
//     solve, window.PatternCloth.solveDrape, rendered by drapeToGroup); a Fold⇄Inflated toggle
//     keeps the rigid M3 fold (the solver's warm start) available. A "Preview detail" control
//     sets the sim node spacing; the settled mesh is CACHED in the doc (params.preview3d) so a
//     reopen is instant. The cloth solve is a blocking ~1–2 s loop, so a "Settling…" badge is
//     shown via a double-rAF before the solve so it actually paints first.
// Geometry/texturing live in preview3d.js (imports only 'three', headless-testable); this entry
// owns the scene, renderer, OrbitControls (touch), the doc fetch, the controls, and the overlay.
// The WebGL canvas is transparent (alpha) so the CSS studio gradient shows through behind the bag.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { docToMesh, panelCanvasTexture, pieceFaceTexture, drapeToGroup, frameObject, contactShadow } from 'preview3d';

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
const controlsEl = document.getElementById('pv-controls');
const detailSel = document.getElementById('pv-detail');
const settlingEl = document.getElementById('pv-settling');
const setMsg = (t) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.hidden = !t; } };
const show = (el, on) => { if (el) el.hidden = !on; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DETAIL_LABEL = { 25: 'Draft', 20: 'Standard', 15: 'Fine' };

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

  // ── freeform WITH a seam graph: inflated drape (default) + fold toggle (M3/M4) ──
  const seams = pat.params && pat.params.seams;
  if (pat.kind === 'freeform' && Array.isArray(seams) && seams.length) {
    if (!window.PatternFold) { setMsg('The 3D engine didn’t load — try reloading the page.'); return; }
    mountFreeform(pat, { scene, camera, controls, resize });
    return;
  }

  // ── freeform without seams, or other kinds ──
  setMsg(pat.kind === 'freeform'
    ? 'No seams yet — open this pattern in Sew mode and join edges to fold it in 3D.'
    : '3D preview supports boxy totes and folded freeform pieces so far — garments are coming.');
}

// ── freeform mount: owns the view (inflated|fold), detail, floor, cache, and the scene swap ──
function mountFreeform(pat, ctx) {
  const { scene, camera, controls, resize } = ctx;
  const params = pat.params;
  const pieces = params.pieces || [];
  const seams = params.seams || [];
  const PC = window.PatternCloth, PF = window.PatternFold;
  const canDrape = !!(PC && PC.solveDrape && window.PatternMesh);
  let view = canDrape ? 'inflated' : 'fold';   // inflated is the default when the solver is present
  let detailH = 20;                            // Standard
  let foldRoot = params.foldRoot || null;

  let curGroup = null, curShadow = null;
  function place(group) {
    if (curGroup) { scene.remove(curGroup); curGroup = null; }
    if (curShadow) { scene.remove(curShadow); curShadow = null; }
    if (!group.children.length) return false;
    scene.add(group); curGroup = group;
    const bb = new THREE.Box3().setFromObject(group);
    const sz = bb.getSize(new THREE.Vector3());
    const sh = contactShadow(sz.x, sz.z);
    if (sh) { sh.position.y = bb.min.y - 2; scene.add(sh); curShadow = sh; }
    frameObject(camera, controls, group, 1.4);
    resize();
    return true;
  }

  function renderFold() {
    const group = docToMesh(pat, { makeTexture: (p) => pieceFaceTexture(p, UNIT) });
    if (!place(group)) {
      setMsg(group.userData.foldError
        ? 'Could not fold this pattern (the seams may not form a foldable shape).'
        : 'Add seams in Sew mode to fold this pattern in 3D.');
      return;
    }
    fillFoldSpec(pat, group.userData.fold);
    setMsg(''); reveal();
  }

  function renderDrape(result, fold) {
    const group = drapeToGroup(pat, result, fold, { makeTexture: (p) => pieceFaceTexture(p, UNIT) });
    if (!place(group)) { setMsg('Add seams in Sew mode to inflate this pattern.'); return; }
    fillDrapeSpec(group.userData.drape, detailH);
    setMsg(''); reveal();
  }

  // Build the inflated drape: cache hit → decode (instant); miss → solve (settling badge) + cache.
  function buildDrape() {
    const hash = PC.geomHash(pieces, seams, { h: detailH, root: foldRoot });
    const cache = params.preview3d;
    const fold = PF.foldDoc(pieces, seams, { root: foldRoot });   // straps (cheap, not cached)
    if (cache && cache.simVersion === PC.SIM_VERSION && cache.geomHash === hash && cache.h === detailH) {
      renderDrape(PC.decodeDrape(cache), fold);
      return;
    }
    showSettling(true);
    // double-rAF so the badge paints BEFORE the synchronous solve blocks the main thread.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      let result;
      try { result = PC.solveDrape(pieces, seams, { h: detailH, root: foldRoot }); }
      catch (e) { showSettling(false); console.warn('[preview] solve failed', e); setMsg('Could not settle this pattern.'); return; }
      showSettling(false);
      if (!result.nodes.length) { setMsg('Add seams in Sew mode to inflate this pattern.'); return; }
      renderDrape(result, fold);
      try {
        params.preview3d = Object.assign(PC.encodeDrape(result), { geomHash: hash, h: detailH, settledAt: new Date().toISOString() });
        saveDoc(pat);
      } catch (e) { console.warn('[preview] cache save failed', e); }
    }));
  }

  const renderActive = () => (view === 'inflated' && canDrape ? buildDrape() : renderFold());

  // View toggle (Inflated ⇄ Folded)
  if (controlsEl) {
    const btns = Array.from(controlsEl.querySelectorAll('.pv-seg__btn'));
    btns.forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.view;
        if (v === view) return;
        if (v === 'inflated' && !canDrape) return;
        view = v;
        btns.forEach((x) => x.classList.toggle('is-on', x.dataset.view === view));
        renderActive();
      };
    });
    // hide the inflated button if the solver didn't load (fold-only fallback)
    if (!canDrape) btns.forEach((b) => { if (b.dataset.view === 'inflated') b.hidden = true; b.classList.toggle('is-on', b.dataset.view === 'fold'); });
  }
  // Detail control (only re-solves when inflated)
  if (detailSel) {
    detailSel.value = String(detailH);
    detailSel.onchange = () => { detailH = +detailSel.value || 20; if (view === 'inflated' && canDrape) buildDrape(); };
  }
  // Floor-piece override — changing it invalidates the drape (geomHash includes foldRoot).
  setupFloor(pat, (root) => {
    foldRoot = root || null;
    params.foldRoot = foldRoot;
    if (view === 'inflated' && canDrape) buildDrape();   // re-solve (hash miss) + saves root+cache
    else { renderFold(); saveDoc(pat); }                  // persist the root for the fold view
  });

  function reveal() { show(specEl, true); show(hintEl, true); show(controlsEl, true); }
  renderActive();
}

// ── settling badge ──
function showSettling(on) { if (settlingEl) settlingEl.hidden = !on; }

// ── POST the doc back (opaque params_json round-trips foldRoot + the preview3d cache) ──
function saveDoc(pat) {
  return fetch(BASE + '/patterns', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: pat.id, name: pat.name, kind: pat.kind, params: pat.params }),
  }).catch((e) => console.warn('[preview] save failed', e));
}

// The inflated-drape readout: pieces, shape state, detail, handles.
function fillDrapeSpec(drape, detailH) {
  if (!specGrid || !drape) return;
  const row = (k, v) => `<div class="pv-spec__row"><span class="pv-spec__k">${k}</span><span class="pv-spec__v">${v}</span></div>`;
  const state = drape.mode === 'cached' ? 'Inflated (saved)'
    : drape.mode === 'degraded' ? 'Inflated (open fold)'
    : drape.mode === 'settled' ? 'Inflated' : 'Inflated (settling capped)';
  specGrid.innerHTML = row('Pieces', String(drape.pieceCount)) + row('Shape', state)
    + row('Detail', DETAIL_LABEL[detailH] || (detailH + ' mm'))
    + (drape.straps && drape.straps.length ? row('Handles', String(drape.straps.length)) : '');
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
  specGrid.innerHTML = row('Pieces', String(fold.pieceCount)) + row('Assembly', line)
    + (fold.straps && fold.straps.length ? row('Handles', String(fold.straps.length)) : '');
}

// The "Floor piece" override — auto-detect can pick wrong (a tall tote's largest panel is a
// wall, not the base); this lets her choose which piece lies flat. The chosen `foldRoot` rides
// the normal save (the tiler ignores it — the print spine is untouched). cb(root) re-renders.
function setupFloor(pat, cb) {
  const sel = document.getElementById('pv-floor');
  if (!sel || !floorEl) return;
  const pieces = (pat.params && pat.params.pieces) || [];
  sel.innerHTML = '<option value="">Floor: auto</option>'
    + pieces.map((p) => `<option value="${esc(p.id)}">Floor: ${esc(p.name || p.id)}</option>`).join('');
  sel.value = pat.params.foldRoot || '';
  show(floorEl, true);
  sel.onchange = () => cb(sel.value || null);
}

// The "finished measurements" spec plate — the strap length lives here (box path).
function fillSpec(pat) {
  if (!specGrid) return;
  const p = pat.params || {};
  const row = (k, v) => `<div class="pv-spec__row"><span class="pv-spec__k">${k}</span><span class="pv-spec__v">${v} <em>${uSuf}</em></span></div>`;
  let html = '';
  if (p.widthMm && p.heightMm && p.depthMm) html += row('Bag', `${dim(p.widthMm)} × ${dim(p.heightMm)} × ${dim(p.depthMm)}`);
  if (p.strapLenMm && p.strapWidthMm) html += row('Strap', `${dim(p.strapLenMm)} × ${dim(p.strapWidthMm)}`);
  specGrid.innerHTML = html;
}
