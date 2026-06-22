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
import { docToMesh, panelCanvasTexture, pieceFaceTexture, drapeToGroup, frameObject, contactShadow, dressFormGroup } from 'preview3d';

const BASE = window.SEWING_BASE || '';
const ident = window.SEWING_PREVIEW || {};
const UNIT = (() => { try { return localStorage.getItem('sewing.unit') || 'in'; } catch (_) { return 'in'; } })();
const uSuf = UNIT === 'cm' ? 'cm' : 'in';
const dim = (mm) => String(Math.round((UNIT === 'cm' ? mm / 10 : mm / 25.4) * 10) / 10);
const toMm = (v) => (UNIT === 'cm' ? v * 10 : v * 25.4);   // display-unit input → mm (the doc is mm)

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
  const hasBody = !!(params.body && window.BodyForm);   // garment → show the dress form (M5b) + gravity drape (M5c)
  let fabric = params.fabric || 'cotton';

  let curGroup = null, curShadow = null, formGroup = null, formShadow = null;

  // (Re)loft the translucent dress form from params.body + seat it on a contact shadow. The
  // form persists across view toggles; M5c will drape the garment ONTO it (today it stands
  // behind the still-flat inflated garment). Re-loft is <1 ms, so this is fine to call live.
  function buildForm() {
    if (formGroup) { scene.remove(formGroup); formGroup = null; }
    if (formShadow) { scene.remove(formShadow); formShadow = null; }
    if (!hasBody) return;
    formGroup = dressFormGroup(params.body);
    if (!formGroup.children.length) { formGroup = null; return; }
    scene.add(formGroup);
    const st = formGroup.userData.stack, hem = st && st.rings[0];
    if (hem) { const sh = contactShadow(2 * hem.a, 2 * hem.b); if (sh) { sh.position.y = -2; scene.add(sh); formShadow = sh; } }
  }

  // Frame the union of the garment + the form so neither is cropped (the form is the taller).
  function frameUnion() {
    const box = new THREE.Box3(); let any = false;
    for (const g of [curGroup, formGroup]) if (g && g.children.length) { box.expandByObject(g); any = true; }
    if (!any) return;
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z) || 1;
    const fitH = maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360));
    const dist = 1.4 * Math.max(fitH, fitH / Math.max(camera.aspect, 0.0001));
    camera.position.copy(center).addScaledVector(new THREE.Vector3(0.9, 0.55, 1).normalize(), dist);
    camera.near = Math.max(dist / 1000, 0.1); camera.far = dist * 1000; camera.updateProjectionMatrix();
    controls.target.copy(center); controls.update();
  }

  function place(group) {
    if (curGroup) { scene.remove(curGroup); curGroup = null; }
    if (curShadow) { scene.remove(curShadow); curShadow = null; }
    if (!group.children.length) return false;
    scene.add(group); curGroup = group;
    if (formGroup) {
      frameUnion();   // the form carries its own shadow; frame both together
    } else {
      const bb = new THREE.Box3().setFromObject(group);
      const sz = bb.getSize(new THREE.Vector3());
      const sh = contactShadow(sz.x, sz.z);
      if (sh) { sh.position.y = bb.min.y - 2; scene.add(sh); curShadow = sh; }
      frameObject(camera, controls, group, 1.4);
    }
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
    fillDrapeSpec(group.userData.drape, detailH, hasBody);
    setMsg(''); reveal();
  }

  // Build the drape: a GARMENT (doc has `body`) drapes under gravity on the dress form; a bag
  // inflates. cache hit → decode (instant); miss → solve (settling badge) + cache.
  function solveOpts() {
    const o = { h: detailH, root: foldRoot };
    if (hasBody) { o.garment = true; o.body = params.body; o.fabric = fabric; }
    return o;
  }
  function buildDrape() {
    const o = solveOpts();
    const hash = PC.geomHash(pieces, seams, o);
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
      try { result = PC.solveDrape(pieces, seams, o); }
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
  // Detail control (only re-solves when inflated/draped)
  if (detailSel) {
    detailSel.value = String(detailH);
    detailSel.onchange = () => { detailH = +detailSel.value || 20; if (view === 'inflated' && canDrape) buildDrape(); };
  }
  // For a garment the "Inflated" view IS the gravity drape — relabel it "Draped".
  if (hasBody && controlsEl) {
    const ib = controlsEl.querySelector('.pv-seg__btn[data-view="inflated"]');
    if (ib) ib.textContent = 'Draped';
  }
  // Fabric control (garments only) — re-solve on change; geomHash includes fabric so it re-keys.
  const fabricSel = document.getElementById('pv-fabric');
  if (fabricSel) {
    if (hasBody) {
      fabricSel.value = fabric;
      show(fabricSel, true);
      fabricSel.onchange = () => {
        fabric = fabricSel.value || 'cotton'; params.fabric = fabric;
        if (view === 'inflated' && canDrape) buildDrape(); else saveDoc(pat);
      };
    } else { show(fabricSel, false); }
  }
  // Floor-piece override — changing it invalidates the drape (geomHash includes foldRoot).
  setupFloor(pat, (root) => {
    foldRoot = root || null;
    params.foldRoot = foldRoot;
    if (view === 'inflated' && canDrape) buildDrape();   // re-solve (hash miss) + saves root+cache
    else { renderFold(); saveDoc(pat); }                  // persist the root for the fold view
  });

  function reveal() { show(specEl, true); show(hintEl, true); show(controlsEl, true); }

  // Measurements panel (M5b): live re-loft on edit, debounced save. Shown only for garments.
  function setupMeasurements() {
    const wrap = document.getElementById('pv-measure');
    if (!hasBody || !wrap) return;
    const NG = window.PatternGeom;
    const ids = { heightMm: 'm-height', bustMm: 'm-bust', waistMm: 'm-waist', hipMm: 'm-hip' };
    const inputs = {};
    for (const k in ids) { const el = document.getElementById(ids[k]); inputs[k] = el; if (el) el.value = dim(params.body[k]); }
    wrap.querySelectorAll('.pv-measure__u').forEach((e) => { e.textContent = uSuf; });
    show(wrap, true);
    let saveTimer = null;
    const onEdit = () => {
      const b = {};
      for (const k in ids) { const v = parseFloat(inputs[k] && inputs[k].value); b[k] = v > 0 ? toMm(v) : params.body[k]; }
      params.body = NG && NG.normalizeBody ? NG.normalizeBody(b) : b;
      buildForm();            // re-loft in place (camera stays put — no jarring re-frame)
      clearTimeout(saveTimer); saveTimer = setTimeout(() => saveDoc(pat), 700);
    };
    for (const k in ids) if (inputs[k]) inputs[k].addEventListener('input', onEdit);
  }

  buildForm();          // stand the form up before the first frameUnion
  setupMeasurements();
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

// The drape readout: pieces, shape state, detail, handles. A garment is "Draped" (on the form
// under gravity); a bag is "Inflated".
function fillDrapeSpec(drape, detailH, garment) {
  if (!specGrid || !drape) return;
  const row = (k, v) => `<div class="pv-spec__row"><span class="pv-spec__k">${k}</span><span class="pv-spec__v">${v}</span></div>`;
  const verb = garment ? 'Draped' : 'Inflated';
  const state = drape.mode === 'cached' ? `${verb} (saved)`
    : drape.mode === 'degraded' ? `${verb} (loose)`
    : drape.mode === 'settled' ? verb : `${verb} (settling capped)`;
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
