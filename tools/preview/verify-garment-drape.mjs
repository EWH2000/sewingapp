// verify-garment-drape.mjs — headless test for the M5c gravity garment drape (the deterministic
// parts; the LOOK + "doesn't explode on her real dress" are the owner gate). Pure: eval poly2tri,
// pattern-geom, body-form, pattern-fold, pattern-mesh, pattern-cloth into a window shim.
//
//   cd ~/sewingapp/tools/preview && node verify-garment-drape.mjs
//
// Checks: a (correctly-sized) garment drapes without NaN; it hangs on the form; the shoulder + side
// seams CLOSE (the M5c-step3 pin-fix: stitch-up unpinned so the top seam — which sits in the pinned
// band — actually sews; bodice pinned at the waist too so it doesn't droop to the wider hip); the
// fit-strain metric is quiet on a fitting garment and FIRES (bounded) on an oversized body; body
// collision; determinism; geomHash regression; dart welds; degrade-never-blank.
import { readFileSync } from "node:fs";

global.window = {};
const APP = "/home/ehill/sewingapp/app/static/js";
for (const f of ["vendor/poly2tri.js", "pattern-geom.js", "body-form.js", "pattern-fold.js", "pattern-mesh.js", "pattern-cloth.js"])
  eval(readFileSync(`${APP}/${f}`, "utf8"));
const Cl = global.window.PatternCloth, BF = global.window.BodyForm;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } };
const N = (x, y) => ({ x, y });
const curve = (cp) => ({ curve: { type: "quad", cp } });
const finite = (nodes) => nodes.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]));

// A correctly-sized sleeveless bodice (mirrors tools/seed-examples.mjs): symmetric taper, waist 390 +
// bust 490 per panel → front+back waist 780 / bust 980 (fits the default body), curved neck+armholes.
const bodice = (id, name, role, neckDip, dart) => {
  const p = {
    id, name, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes: [N(50, 0), N(440, 0), N(490, 230), N(452, 420), N(311, 400), N(179, 400), N(38, 420), N(0, 230)],
    edges: { "2": curve([0.5, 0.16]), "4": curve([0.5, neckDip]), "6": curve([0.5, 0.16]) },
  };
  if (dart) p.darts = [{ id: "d_waist", edge: 0, center: 0.5, width: 26, depth: 120, kind: "wedge" }];
  return p;
};
const front = bodice("bf", "Bodice Front", "front", 0.28, false);
const back = bodice("bb", "Bodice Back", "back", 0.10, false);
// shoulders CROSS (front-R ↔ back-L) like the sides, because the back wraps mirror-image.
const seams = [
  { a: { piece: "bf", edge: 3 }, b: { piece: "bb", edge: 5 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] },  // R shoulder
  { a: { piece: "bf", edge: 5 }, b: { piece: "bb", edge: 3 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] },  // L shoulder
  { a: { piece: "bf", edge: 1 }, b: { piece: "bb", edge: 7 } },  // R side
  { a: { piece: "bf", edge: 7 }, b: { piece: "bb", edge: 1 } },  // L side
];
const body = BF.DEFAULT_BODY;
const opts = { h: 20, garment: true, body };   // Standard detail (the default the owner gates on)

// helper: split inter-piece seam residuals into shoulder-band (top) vs side (lower) by node height.
function seamResiduals(r) {
  const np = new Array(r.nodes.length).fill("?");
  r.pieceRanges.forEach((pr) => { for (let k = 0; k < pr.count; k++) np[pr.start + k] = pr.piece; });
  let shoulder = 0, side = 0;
  for (const [i, j] of r.seamLinks || []) {
    if (np[i] === np[j]) continue;                         // dart weld — not an inter-piece seam
    const a = r.nodes[i], b = r.nodes[j], d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (a[1] > 1300 || b[1] > 1300) shoulder = Math.max(shoulder, d); else side = Math.max(side, d);
  }
  return { shoulder, side };
}
// settled node nearest an authored localUV (for landmark distances).
function nodeNearUV(r, piece, uv) {
  const pr = r.pieceRanges.find((p) => p.piece === piece); if (!pr) return null;
  let best = Infinity, bi = -1;
  for (let k = 0; k < pr.count; k++) { const u = r.localUV[pr.start + k]; const d = Math.hypot(u[0] - uv[0], u[1] - uv[1]); if (d < best) { best = d; bi = pr.start + k; } }
  return r.nodes[bi];
}
// the bodice armhole-TOP twist: front node3 (452,420) ↔ back node6 (38,420) on the R; mirror on the L.
// The crossed shoulder seam, sewn the WRONG direction, lands these ~130mm apart (armhole twisted) while
// the shoulder-seam residual still reads ~0 — so this is the guard the shoulder<15 assert can't provide.
function armholeTwist(r, fId, bId) {
  const D3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return { R: D3(nodeNearUV(r, fId, [452, 420]), nodeNearUV(r, bId, [38, 420])),
           L: D3(nodeNearUV(r, fId, [38, 420]), nodeNearUV(r, bId, [452, 420])) };
}

console.log("=== garment drapes without NaN, on the form ===");
const r = Cl.solveDrape([front, back], seams, opts);
ok(r.nodes.length > 0 && r.tris.length > 0, `produced a mesh (${r.nodes.length} nodes, ${r.tris.length} tris)`);
ok(finite(r.nodes), "no NaN/Inf in the settled mesh");
ok(r.mode === "settled" || r.mode === "warm", `mode is settled/warm, not degraded (${r.mode})`);

console.log("=== the shoulder + side seams CLOSE + the armhole is UNTWISTED (M6) ===");
const res = seamResiduals(r);
ok(res.shoulder < 15, `shoulder seam closes (max residual ${res.shoulder.toFixed(1)}mm — was ~175mm with the pinned-band bug)`);
ok(res.side < 15, `side seam closes (max residual ${res.side.toFixed(1)}mm)`);
// THE M6 GUARD: the bodice armhole must be an UNTWISTED loop (front/back armhole-tops together). The
// shoulder<15 assert above is BLIND to this — the old per-seam-geometric flip closed the shoulder seam
// while crossing the armhole ~130mm (front z≈−69 / back z≈+68). The gated fold-direction flip untwists it.
const tw = armholeTwist(r, "bf", "bb");
ok(tw.R < 40 && tw.L < 40, `armhole is untwisted (front↔back armhole-top R=${tw.R.toFixed(0)}mm L=${tw.L.toFixed(0)}mm — was ~137mm crossed)`);
// the rollback flag (pin the band BEFORE the stitch-up) still regresses the shoulder vs the fix
const rOld = Cl.solveDrape([front, back], seams, Object.assign({}, opts, { stitchUnpinned: false }));
ok(seamResiduals(rOld).shoulder > res.shoulder + 40, `stitchUnpinned:false regresses the shoulder (${seamResiduals(rOld).shoulder.toFixed(0)}mm vs ${res.shoulder.toFixed(0)}mm) — the unpinned stitch-up still helps close it`);

console.log("=== the fit-strain metric is present + QUIET on a fitting garment ===");
ok(r.strain && typeof r.strain.overTension === "boolean", "strain object present on the garment result");
ok(r.strain.overTension === false, `a fitting garment does NOT warn (maxGap ${r.strain.maxSeamGapMm.toFixed(1)}mm < threshold)`);
ok(Array.isArray(r.strain.gapSegs) && r.strain.gapSegs.length === 0, "no gap-highlight segments when it fits");

console.log("=== it hangs ON the form (hugs the surface, doesn't poke deep; top up, hem down) ===");
const form = BF.loft(body);
// a FITTED bodice sits ON the body, so many nodes are at the surface — the meaningful check is that
// none pokes DEEP through it (the collision skin is 6mm; allow up to ~2× before it reads as clipping).
const maxPen = r.nodes.reduce((m, p) => Math.max(m, -Math.min(0, BF.signedDist(form, p))), 0);
ok(maxPen < 14, `cloth hugs the surface without poking deep into the body (max penetration ${maxPen.toFixed(1)}mm)`);
const ys = r.nodes.map((p) => p[1]);
const topY = Math.max(...ys), botY = Math.min(...ys);
ok(topY > form.bands.find((b) => b.role === "waist").y, "the garment reaches up to the bust/shoulder band (pinned top stays up)");
ok(botY < topY - 100, `the hem falls well below the top (span ${(topY - botY).toFixed(0)}mm)`);
const zs = r.nodes.map((p) => p[2]);
ok(Math.max(...zs) > 20 && Math.min(...zs) < -20, "panels wrapped to front (+z) AND back (−z) of the form");

console.log("=== the warning FIRES (bounded) when the body outgrows the garment ===");
const rBig = Cl.solveDrape([front, back], seams, Object.assign({}, opts, { body: Object.assign({}, body, { bustMm: 1400, waistMm: 1200 }) }));
ok(finite(rBig.nodes), "oversized-body drape still finite (no explosion)");
ok(rBig.strain.overTension === true && rBig.strain.wontClose === true, `oversized body warns (maxGap ${rBig.strain.maxSeamGapMm.toFixed(0)}mm, wontClose)`);
ok(rBig.strain.gapSegs.length > 0, "the over-tension drape carries gap-highlight segments");
// the stretch ceiling is a soft (Gauss–Seidel) bound: a modest misfit stays near 1.15, but a wildly
// oversized body (here +50%) still gaps AND stretches near the gap — the point is it doesn't EXPLODE.
ok(rBig.strain.maxStretchRatio < 4, `stretch stayed bounded — no explosion (p95 ${rBig.strain.maxStretchRatio.toFixed(2)})`);
// honesty stress: a uniformly-too-small garment (0.7× about each panel's centroid) can't reach around the
// body → its SIDE seams gap → it MUST still warn. This proves the M6 shoulder-close (which uses a full
// ridge climb + a straggler snap) does NOT mask a genuine misfit — the girth channel is independent.
{
  const scale = (p) => { const cx = p.nodes.reduce((a, n) => a + n.x, 0) / p.nodes.length, cy = p.nodes.reduce((a, n) => a + n.y, 0) / p.nodes.length;
    return Object.assign({}, p, { nodes: p.nodes.map((n) => ({ x: cx + (n.x - cx) * 0.7, y: cy + (n.y - cy) * 0.7 })) }); };
  const rSmall = Cl.solveDrape([scale(front), scale(back)], seams, opts);
  ok(finite(rSmall.nodes), "too-small drape still finite");
  ok(rSmall.strain.overTension === true, `a too-small garment still warns (maxGap ${rSmall.strain.maxSeamGapMm.toFixed(0)}mm) — the ridge close does NOT fake it shut`);
}

console.log("=== body collision pushes an inside point out ===");
const p0 = [0, form.bands.find((b) => b.role === "bust").y, 0];   // dead centre at bust height
ok(BF.insideForm(form, p0), "test point starts inside the body");
const s = BF.nearestSurface(form, p0, 6);
ok(!BF.insideForm(form, s.point), "nearestSurface projects it OUTSIDE the body");
ok(Math.abs(s.point[1] - p0[1]) < 1e-6, "the push is horizontal (height preserved — won't unzip seams)");

console.log("=== determinism ===");
const r2 = Cl.solveDrape([front, back], seams, opts);
let maxd = 0; for (let i = 0; i < r.nodes.length; i++) for (let d = 0; d < 3; d++) maxd = Math.max(maxd, Math.abs(r.nodes[i][d] - r2.nodes[i][d]));
ok(maxd < 1e-6, `two solves identical (max Δ ${maxd.toExponential(1)})`);

console.log("=== geomHash re-keys on body/fabric; a BAG's hash is unchanged (regression) ===");
const hCotton = Cl.geomHash([front, back], seams, { h: 25, garment: true, body, fabric: "cotton" });
const hDenim = Cl.geomHash([front, back], seams, { h: 25, garment: true, body, fabric: "denim" });
const hBigBust = Cl.geomHash([front, back], seams, { h: 25, garment: true, body: Object.assign({}, body, { bustMm: 1010 }), fabric: "cotton" });
ok(hCotton !== hDenim, "fabric change re-keys the hash");
ok(hCotton !== hBigBust, "a body (bust) change re-keys the hash");
const bag = [{ id: "p", name: "P", count: 1, nodes: [N(0, 0), N(200, 0), N(200, 200), N(0, 200)] }];
ok(Cl.geomHash(bag, [], { h: 20 }) === Cl.geomHash(bag, [], { h: 20 }), "bag hash deterministic + garment block skipped (byte-identical)");

console.log("=== a wedge dart sews shut + shapes the bodice front (and is excluded from seam strain) ===");
{
  const darted = bodice("bf", "Bodice Front", "front", 0.28, true);
  const dm = global.window.PatternMesh.triangulatePiece(global.window.PatternGeom.normalizePieces({ pieces: [darted] })[0], opts.h);
  const leg0 = dm.boundaryMeta.filter((m) => m && m.dart === "d_waist" && m.leg === 0).length;
  const leg1 = dm.boundaryMeta.filter((m) => m && m.dart === "d_waist" && m.leg === 1).length;
  ok(leg0 > 0 && leg1 > 0, `dart legs tagged on the cut mesh (leg0=${leg0}, leg1=${leg1})`);
  const dpairs = global.window.PatternMesh.selfSeamPairs(dm, "d_waist");
  ok(dpairs.length > 0 && dpairs.every((p) => p[0] !== p[1]), `selfSeamPairs pairs the legs (${dpairs.length}, no self-pair)`);
  const rd = Cl.solveDrape([darted, back], seams, opts);
  const fr = rd.pieceRanges.find((p) => p.piece === "bf");
  let gap = 0; for (const pp of dpairs) { const i = fr.start + pp[0], j = fr.start + pp[1]; gap += Math.hypot(rd.nodes[i][0] - rd.nodes[j][0], rd.nodes[i][1] - rd.nodes[j][1], rd.nodes[i][2] - rd.nodes[j][2]); }
  // the weld pulls the legs together (vs the 26mm authored mouth) so the dart reads sewn, not gaping.
  // On a FITTED bodice the body provides the bust shape, so the dart's job here is waist suppression +
  // a clean closure rather than the big front-back depth it added on the old loose (undersized) panel.
  ok(gap / dpairs.length < 15, `dart sews mostly shut under gravity (mean leg gap ${(gap / dpairs.length).toFixed(1)}mm < the 26mm authored mouth)`);
  ok(finite(rd.nodes), "darted drape has no NaN");
  // the dart is a same-piece WELD — it must NOT appear as an inter-piece seam in the strain metric
  ok((rd.strain.seams || []).every((sm) => sm.seam !== "d_waist"), "dart weld is excluded from the seam-strain list (inter-piece seams only)");
}

console.log("=== a skirt (top-pinned, hem free) still drapes finite — unpinned-stitch-up didn't break it ===");
{
  const sk = (id, role) => ({ id, name: id, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes: [N(0, 0), N(760, 0), N(575, 560), N(185, 560)] });   // hem 760, waist 390 (A-line)
  const skf = sk("skf", "front-skirt"), skb = sk("skb", "back-skirt");
  const skSeams = [{ a: { piece: "skf", edge: 1 }, b: { piece: "skb", edge: 3 } }, { a: { piece: "skf", edge: 3 }, b: { piece: "skb", edge: 1 } }];
  const rs = Cl.solveDrape([skf, skb], skSeams, opts);
  ok(finite(rs.nodes) && rs.nodes.length > 0, "skirt drapes finite");
  ok(rs.mode !== "degraded", `skirt not degraded (${rs.mode})`);
  const sy = rs.nodes.map((p) => p[1]);
  ok(Math.min(...sy) < form.bands.find((b) => b.role === "waist").y, "skirt hangs below the waist");
  // M6 NO-REGRESSION: the gated fold-flip EXCLUDES skirt seams (they keep the wrapped direction), so the
  // skirt side seams must still close — confirm the untwist change didn't break the skirt.
  ok(seamResiduals(rs).side < 20, `skirt side seams still close (${seamResiduals(rs).side.toFixed(1)}mm) — the fold-flip gate spares skirts`);
}

console.log("=== M6 NO-REGRESSION: a DRESS (bodice+skirt) — armhole untwisted, all seams close ===");
{
  const dbod = (id, role, nd) => ({ id, name: id, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes: [N(50, 0), N(440, 0), N(490, 230), N(452, 420), N(311, 400), N(179, 400), N(38, 420), N(0, 230)],
    edges: { "2": curve([0.5, 0.16]), "4": curve([0.5, nd]), "6": curve([0.5, 0.16]) } });
  const dskirt = (id, role) => ({ id, name: role, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes: [N(0, 0), N(490, 0), N(575, 560), N(-85, 560)] });
  const df = dbod("df", "front", 0.28), db = dbod("db", "back", 0.10), dsf = dskirt("dsf", "front-skirt"), dsb = dskirt("dsb", "back-skirt");
  const dseams = [
    { a: { piece: "df", edge: 3 }, b: { piece: "db", edge: 5 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] },
    { a: { piece: "df", edge: 5 }, b: { piece: "db", edge: 3 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] },
    { a: { piece: "df", edge: 1 }, b: { piece: "db", edge: 7 } }, { a: { piece: "df", edge: 7 }, b: { piece: "db", edge: 1 } },
    { a: { piece: "df", edge: 0 }, b: { piece: "dsf", edge: 0 } }, { a: { piece: "db", edge: 0 }, b: { piece: "dsb", edge: 0 } },
    { a: { piece: "dsf", edge: 1 }, b: { piece: "dsb", edge: 3 } }, { a: { piece: "dsf", edge: 3 }, b: { piece: "dsb", edge: 1 } },
  ];
  const rd = Cl.solveDrape([df, db, dsf, dsb], dseams, opts);
  ok(finite(rd.nodes) && rd.mode !== "degraded", `dress drapes finite, not degraded (${rd.mode})`);
  const dtw = armholeTwist(rd, "df", "db");
  ok(dtw.R < 40 && dtw.L < 40, `dress bodice armhole untwisted (R=${dtw.R.toFixed(0)}mm L=${dtw.L.toFixed(0)}mm)`);
  ok(seamResiduals(rd).shoulder < 15, `dress shoulder seams close (${seamResiduals(rd).shoulder.toFixed(1)}mm)`);
  ok(rd.strain.overTension === false, "a fitting dress does NOT warn");
}

console.log("=== degrade-never-blank (garment, no seams → loose panels still drape) ===");
const rNoSeam = Cl.solveDrape([front, back], [], opts);
ok(rNoSeam.nodes.length > 0 && finite(rNoSeam.nodes), "a seamless garment still returns a finite mesh (no blank)");

console.log("=== cloth self-collision separates non-adjacent layers (BUG 1), deterministic + gated ===");
{
  // min distance between NON-adjacent node pairs — a proxy for cloth-cloth interpenetration (the lower-
  // bodice crumple). Adjacency from the exposed tris (3 edges each) + seamLinks; spatial-hashed → O(N).
  const sepOf = (r) => {
    const adj = new Set(), Nn = r.nodes.length, ae = (a, b) => { const i = a < b ? a : b, j = a < b ? b : a; if (i !== j) adj.add(i * Nn + j); };
    for (const t of r.tris) { ae(t[0], t[1]); ae(t[1], t[2]); ae(t[2], t[0]); }
    for (const [i, j] of r.seamLinks || []) ae(i, j);
    const cell = 12, OFF = 1024, B = 2048, bk = Object.create(null);
    for (let i = 0; i < Nn; i++) { const p = r.nodes[i]; const k = (Math.floor(p[0] / cell) + OFF) + (Math.floor(p[1] / cell) + OFF) * B + (Math.floor(p[2] / cell) + OFF) * B * B; (bk[k] || (bk[k] = [])).push(i); }
    let mn = Infinity;
    for (let i = 0; i < Nn; i++) {
      const p = r.nodes[i], cx = Math.floor(p[0] / cell) + OFF, cy = Math.floor(p[1] / cell) + OFF, cz = Math.floor(p[2] / cell) + OFF;
      for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) for (let az = -1; az <= 1; az++) {
        const b = bk[(cx + ax) + (cy + ay) * B + (cz + az) * B * B]; if (!b) continue;
        for (const j of b) { if (j <= i || adj.has(i * Nn + j)) continue; const q = r.nodes[j]; const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (d < mn) mn = d; }
      }
    }
    return mn;
  };
  const rOn = Cl.solveDrape([front, back], seams, opts);                                       // selfCollide defaults ON for garments
  const rOff = Cl.solveDrape([front, back], seams, Object.assign({}, opts, { selfCollide: false }));
  ok(sepOf(rOn) > sepOf(rOff), `self-collision separates layers (min non-adjacent gap ${sepOf(rOn).toFixed(2)}mm ON vs ${sepOf(rOff).toFixed(2)}mm OFF)`);
  ok(finite(rOn.nodes), "self-collision drape has no NaN/Inf");
  const rOn2 = Cl.solveDrape([front, back], seams, opts);
  let md = 0; for (let i = 0; i < rOn.nodes.length; i++) for (let d = 0; d < 3; d++) md = Math.max(md, Math.abs(rOn.nodes[i][d] - rOn2.nodes[i][d]));
  ok(md < 1e-9, `self-collision is deterministic (max Δ ${md.toExponential(1)})`);
  let mr = 0; for (let i = 0; i < rOff.nodes.length; i++) for (let d = 0; d < 3; d++) mr = Math.max(mr, Math.abs(rOff.nodes[i][d] - rOn.nodes[i][d]));
  ok(mr > 1e-6, `selfCollide:false changes the result (max Δ ${mr.toFixed(1)}mm) — the gate cleanly disables it (rollback)`);
}

console.log("=== self-collision re-keys geomHash; a BAG's hash stays byte-identical ===");
{
  const hOn = Cl.geomHash([front, back], seams, { h: 20, garment: true, body, selfCollide: true });
  const hOff = Cl.geomHash([front, back], seams, { h: 20, garment: true, body, selfCollide: false });
  const hThick = Cl.geomHash([front, back], seams, { h: 20, garment: true, body, clothThick: 6 });
  ok(hOn !== hOff, "toggling selfCollide re-keys the garment hash");
  ok(hOn !== hThick, "changing clothThick re-keys the garment hash");
  ok(hOn !== Cl.geomHash([front, back], seams, { h: 20, garment: true, body, smoothSteps: 2 }), "changing smoothSteps re-keys the garment hash");
  const bag2 = [{ id: "p", name: "P", count: 1, nodes: [N(0, 0), N(200, 0), N(200, 200), N(0, 200)] }];
  ok(Cl.geomHash(bag2, [], { h: 20 }) === Cl.geomHash(bag2, [], { h: 20, selfCollide: false }), "a bag's hash ignores garment-only self-collision opts (byte-identical)");
}

console.log("=== surface smoothing (de-jag) lowers roughness, keeps seams closed, preserves the warning ===");
{
  // mean per-node Laplacian — the surface's high-frequency roughness (the jagged waist band).
  const roughness = (r) => {
    const nb = Array.from({ length: r.nodes.length }, () => new Set());
    for (const t of r.tris) { nb[t[0]].add(t[1]); nb[t[0]].add(t[2]); nb[t[1]].add(t[0]); nb[t[1]].add(t[2]); nb[t[2]].add(t[0]); nb[t[2]].add(t[1]); }
    let s = 0, c = 0;
    for (let i = 0; i < r.nodes.length; i++) { const a = nb[i]; if (!a.size) continue; let cx = 0, cy = 0, cz = 0; for (const j of a) { cx += r.nodes[j][0]; cy += r.nodes[j][1]; cz += r.nodes[j][2]; } cx /= a.size; cy /= a.size; cz /= a.size; s += Math.hypot(r.nodes[i][0] - cx, r.nodes[i][1] - cy, r.nodes[i][2] - cz); c++; }
    return c ? s / c : 0;
  };
  const smooth = Cl.solveDrape([front, back], seams, opts);                                  // smoothing default ON
  const jagged = Cl.solveDrape([front, back], seams, Object.assign({}, opts, { smoothSteps: 0 }));
  ok(roughness(smooth) < roughness(jagged), `smoothing lowers mean surface roughness (${roughness(smooth).toFixed(2)}mm vs ${roughness(jagged).toFixed(2)}mm unsmoothed)`);
  ok(seamResiduals(smooth).shoulder < 15 && seamResiduals(smooth).side < 15, "seams stay CLOSED after smoothing (bridged across the seam + re-snapped)");
  ok(finite(smooth.nodes), "smoothed drape has no NaN/Inf");
  let md = 0; const s2 = Cl.solveDrape([front, back], seams, opts);
  for (let i = 0; i < smooth.nodes.length; i++) for (let d = 0; d < 3; d++) md = Math.max(md, Math.abs(smooth.nodes[i][d] - s2.nodes[i][d]));
  ok(md < 1e-9, `smoothing is deterministic (max Δ ${md.toExponential(1)})`);
  // smoothing must NOT hide a genuine misfit: an oversized body still gaps + warns (far seam pairs aren't bridged/snapped)
  const rBig2 = Cl.solveDrape([front, back], seams, Object.assign({}, opts, { body: Object.assign({}, body, { bustMm: 1400, waistMm: 1200 }) }));
  ok(rBig2.strain.overTension === true, "an oversized body still warns despite smoothing (far seam pairs are not snapped)");
}

console.log("=== SET-IN SLEEVE (M6 Stage B1): the WORKING properties — bodice intact, tube closes, no penetration ===");
// M6 (2026-06-25): the cap↔armhole closure — formerly the OPEN problem (~100mm gap at the shoulder) — is
// now closed by UNTWISTING the bodice armhole (gated fold-flip + over-the-shoulder ridge drape). The cap
// drops to ~15mm (no arms) / ~23mm (over the arm). This test locks the bodice + tube + cap closure.
{
  const G = global.window.PatternGeom;
  const fArm = G.bodiceArmholes(front), bArm = G.bodiceArmholes(back);
  const pcs = [front, back], sm = seams.slice();
  for (const side of ["R", "L"]) {
    const fA = fArm[side], bA = G.matchedBackArmhole(front, fA.edge, back, bArm, seams) || bArm[side];
    const rr = G.draftSleeve({ armholeFrontMm: fA.len, armholeBackMm: bA.len, bicepMm: 294, capEaseFrac: 0.06, side });
    const slv = rr.piece; slv.id = "slv_" + side; pcs.push(slv);
    sm.push({ a: { piece: slv.id, edge: 3 }, b: { piece: "bf", edge: fA.edge }, ease: 0.06 });
    sm.push({ a: { piece: slv.id, edge: 2 }, b: { piece: "bb", edge: bA.edge }, ease: 0.06 });
    sm.push({ a: { piece: slv.id, edge: 1 }, b: { piece: slv.id, edge: 4 } });
  }
  ok(window.PatternFold.isStrapPiece(pcs[2], sm) === false, "a sleeve is NOT misclassified as a strap (placeGarment won't skip it)");
  const rs = Cl.solveDrape(pcs, sm, opts);
  ok(finite(rs.nodes), "sleeved garment drapes without NaN/Inf");
  // node → piece
  const np = new Array(rs.nodes.length).fill("?");
  rs.pieceRanges.forEach((pr) => { for (let k = 0; k < pr.count; k++) np[pr.start + k] = pr.piece; });
  ok(rs.pieceRanges.filter((pr) => /slv/.test(pr.piece)).length === 2, "both sleeves are in the drape (not pulled out like straps)");
  let bodiceGap = 0, underarm = 0;
  for (const [i, j] of rs.seamLinks || []) {
    const si = /slv/.test(np[i]), sj = /slv/.test(np[j]);
    const a = rs.nodes[i], b = rs.nodes[j], d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (si && sj) underarm = Math.max(underarm, d);          // sleeve underarm self-seam
    else if (!si && !sj) bodiceGap = Math.max(bodiceGap, d); // bodice's own seams (must stay closed — the phasing fix)
  }
  ok(bodiceGap < 15, `the bodice's own seams stay CLOSED with sleeves attached (${bodiceGap.toFixed(1)}mm — the cap-seam phasing keeps the cap from dragging the shoulder open)`);
  ok(underarm < 15, `the sleeve underarm self-seam zips the tube shut (${underarm.toFixed(1)}mm — the non-dart same-piece spring)`);
  const form2 = BF.loft(body);
  const pen = rs.nodes.reduce((m, p) => Math.max(m, -Math.min(0, BF.signedDist(form2, p))), 0);
  // Stage B2: the arm sits CLOSE to the torso so it FILLS the sleeve (the owner's goal); a few sleeve
  // nodes clip into the form at the armpit (arm∩torso overlap) — an inherent soft-body limit, kept low
  // and translucent/least-visible. Sleeveless bodice/skirt/dress + bags stay byte-identical (own tests).
  ok(pen < 16, `body penetration bounded at the armpit with sleeves (${pen.toFixed(1)}mm — arm∩torso soft-body limit)`);
  ok(rs.strain.overTension === false, "an eased cap does NOT false-trip the over-tension warning (cap seams are out of the strain gate)");
  // sleeves land outside the torso on opposite sides (R → +x, L → −x)
  const sx = (id) => { const pr = rs.pieceRanges.find((p) => p.piece === id); let s = 0; for (let k = 0; k < pr.count; k++) s += rs.nodes[pr.start + k][0]; return s / pr.count; };
  ok(sx("slv_R") > 50 && sx("slv_L") < -50, `sleeves drape on opposite sides outside the torso (R x̄=${sx("slv_R").toFixed(0)}, L x̄=${sx("slv_L").toFixed(0)})`);

  // ── Stage B2: the sleeve drapes OVER an arm (the owner's goal) — arms must not WORSEN the
  // cap↔armhole gap, and the sleeve must hug its arm (not hang flat beside the torso). ──
  const capOf = (r) => {
    const q = new Array(r.nodes.length).fill("?"); r.pieceRanges.forEach((pr) => { for (let k = 0; k < pr.count; k++) q[pr.start + k] = pr.piece; });
    let c = 0; for (const [i, j] of r.seamLinks || []) { if (/slv/.test(q[i]) !== /slv/.test(q[j])) { const a = r.nodes[i], b = r.nodes[j]; c = Math.max(c, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); } } return c;
  };
  const capArms = capOf(rs);                                                  // arms derived ON (sleeve present)
  const capNoArms = capOf(Cl.solveDrape(pcs, sm, Object.assign({}, opts, { arms: false })));
  // M6: untwisting the armhole drops the cap↔armhole gap from ~86mm to ~15mm (no arms) / ~23mm (arms) —
  // the cap can finally close onto a CLEAN armhole loop. The arm adds a small outboard pull; bounded here.
  ok(capNoArms < 25, `M6: the untwisted armhole nearly closes the cap↔armhole gap (no-arms ${capNoArms.toFixed(0)}mm — was ~86mm twisted)`);
  ok(capArms < 32, `the cap stays nearly closed over the arm (arms ${capArms.toFixed(0)}mm)`);
  console.log(`   (M6: cap↔armhole gap ${capNoArms.toFixed(0)}mm → ${capArms.toFixed(0)}mm with arms — was ~86mm before the untwist)`);
  const formArmed = BF.loft(body, { arms: true });
  ok(formArmed.arms && formArmed.arms.length === 2, "the solver lofts two arms for the sleeved garment");
  const armR = formArmed.arms.find((a) => a.side === "R");
  const distAxis = (p, a) => { const ax = a.p1[0] - a.p0[0], ay = a.p1[1] - a.p0[1], az = a.p1[2] - a.p0[2], L2 = ax * ax + ay * ay + az * az || 1; let t = ((p[0] - a.p0[0]) * ax + (p[1] - a.p0[1]) * ay + (p[2] - a.p0[2]) * az) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(p[0] - (a.p0[0] + t * ax), p[1] - (a.p0[1] + t * ay), p[2] - (a.p0[2] + t * az)); };
  const prR = rs.pieceRanges.find((p) => p.piece === "slv_R"); let near = 0; for (let k = 0; k < prR.count; k++) if (distAxis(rs.nodes[prR.start + k], armR) < armR.r0 * 2) near++;
  ok(near / prR.count > 0.6, `most slv_R nodes hug the R arm — drapes OVER the limb, not flat (${near}/${prR.count} within 2·r0 of the axis)`);
  // ── THE owner's complaint, locked: the sleeve WRAPS the limb (goes ALL the way around), not a flat
  // flap over the outer side. Measure angular coverage around the arm axis over a mid-sleeve band, in
  // the SAME mirror-safe frame the warm-start uses (eTop = world-up ⟂ axis; eSide forced +z). A flat
  // flap covers ~100°; a real wrap covers most of 360°. (This is what the lenient 2·r0 check missed —
  // a sagging pouch under the arm still passed it, but the owner's eye caught the missing wrap.)
  const wrapCoverage = (id, a) => {
    const ax = a.p1[0] - a.p0[0], ay = a.p1[1] - a.p0[1], az = a.p1[2] - a.p0[2], L2 = ax * ax + ay * ay + az * az, dl = Math.sqrt(L2), dir = [ax / dl, ay / dl, az / dl];
    const upd = dir[1]; let eTop = [-upd * dir[0], 1 - upd * dir[1], -upd * dir[2]]; const en = Math.hypot(eTop[0], eTop[1], eTop[2]); eTop = [eTop[0] / en, eTop[1] / en, eTop[2] / en];
    let eS = [dir[1] * eTop[2] - dir[2] * eTop[1], dir[2] * eTop[0] - dir[0] * eTop[2], dir[0] * eTop[1] - dir[1] * eTop[0]]; if (eS[2] < 0) eS = [-eS[0], -eS[1], -eS[2]];
    const pr = rs.pieceRanges.find((p) => p.piece === id); let lo = 999, hi = -999, top = false, bot = false;
    for (let k = 0; k < pr.count; k++) {
      const p = rs.nodes[pr.start + k], w = [p[0] - a.p0[0], p[1] - a.p0[1], p[2] - a.p0[2]], t = (w[0] * ax + w[1] * ay + w[2] * az) / L2;
      if (t < 0.15 || t > 0.32) continue;
      const f = [a.p0[0] + t * ax, a.p0[1] + t * ay, a.p0[2] + t * az], rv = [p[0] - f[0], p[1] - f[1], p[2] - f[2]];
      const ct = rv[0] * eTop[0] + rv[1] * eTop[1] + rv[2] * eTop[2], cs = rv[0] * eS[0] + rv[1] * eS[1] + rv[2] * eS[2], ang = Math.atan2(cs, ct) * 180 / Math.PI;
      lo = Math.min(lo, ang); hi = Math.max(hi, ang); if (ct > 8) top = true; if (ct < -8) bot = true;
    }
    return { span: hi - lo, top, bot };
  };
  const armL = formArmed.arms.find((a) => a.side === "L");
  const wcR = wrapCoverage("slv_R", armR), wcL = wrapCoverage("slv_L", armL);
  ok(wcR.span > 270 && wcL.span > 270, `each sleeve WRAPS most of the way around its arm (coverage R=${wcR.span.toFixed(0)}° L=${wcL.span.toFixed(0)}° — a flat flap is ~100°)`);
  ok(wcR.top && wcR.bot && wcL.top && wcL.bot, "fabric sits on BOTH the top and underside of each arm (a ring, not a pouch sagging under)");
  // The B2 FIX the owner gated on: the two sleeves drape MIRROR-SYMMETRICALLY (the near-vertical arm
  // aligns with gravity). A regression here = "one side wraps, the other doesn't" (what she saw).
  const centroid = (id) => { const pr = rs.pieceRanges.find((p) => p.piece === id); let x = 0, y = 0, z = 0, zlo = 1e9, zhi = -1e9; for (let k = 0; k < pr.count; k++) { const p = rs.nodes[pr.start + k]; x += p[0]; y += p[1]; z += p[2]; zlo = Math.min(zlo, p[2]); zhi = Math.max(zhi, p[2]); } return { x: x / pr.count, y: y / pr.count, z: z / pr.count, zspread: zhi - zlo }; };
  const cR = centroid("slv_R"), cL = centroid("slv_L");
  ok(Math.abs(cR.x + cL.x) < 25 && Math.abs(cR.y - cL.y) < 25 && Math.abs(cR.z - cL.z) < 25,
     `the two sleeves drape MIRROR-symmetrically (Δx̄=${Math.abs(cR.x + cL.x).toFixed(0)}, Δȳ=${Math.abs(cR.y - cL.y).toFixed(0)}, Δz̄=${Math.abs(cR.z - cL.z).toFixed(0)})`);
  ok(cR.zspread > 60 && cL.zspread > 60, `both sleeves WRAP their arm front-to-back, not hang flat (z-spread R=${cR.zspread.toFixed(0)} L=${cL.zspread.toFixed(0)})`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
