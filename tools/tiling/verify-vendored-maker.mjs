// verify-vendored-maker.mjs — guards the BROWSER Maker stack the editor actually loads:
// vendor/bezier.js (the global `Bezier`) + vendor/browser.maker.js + maker-shim.js. The other
// headless tests import npm `makerjs`, which BUNDLES bezier-js, so they CANNOT catch a missing
// browser Bezier global — exactly the regression that blanked the editor for curved garments.
// This loads the exact vendored files and asserts: (1) a curved piece flattens, and (2) a missing
// Bezier degrades pieceGeom to straight edges instead of THROWING (which blanks the canvas).
import { readFileSync } from "node:fs";

const APP = "/home/ehill/sewingapp/app/static/js", V = APP + "/vendor";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

global.window = {};
// 1) bezier.js installs the global `Bezier` (as a deferred <script src> would)
global.Bezier = new Function(readFileSync(V + "/bezier.js", "utf8") + "; return Bezier;")();
ok(typeof global.Bezier === "function" && !!global.Bezier.prototype, "vendored bezier.js exposes the Bezier global");
// 2) the vendored Maker bundle + shim → window.makerjs
const wrap = (src) => new Function("window", "self", "module", "exports", src);
wrap(readFileSync(V + "/browser.maker.js", "utf8"))(global.window, global.window, undefined, undefined);
wrap(readFileSync(V + "/maker-shim.js", "utf8"))(global.window, global.window, undefined, undefined);
ok(global.window.makerjs && typeof global.window.makerjs.models.BezierCurve === "function",
   "vendored maker-shim exposes window.makerjs + BezierCurve");
eval(readFileSync(APP + "/pattern-geom.js", "utf8"));
const G = global.window.PatternGeom;

const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const curved = { id: "p", name: "C", count: 1, closed: true, seamMm: 12, nodes: rect(200, 300),
  edges: { "2": { curve: { type: "quad", cp: [0.5, 0.2] } } } };

// with the Bezier global present, the curve flattens to many points (subdivided, not a straight chord)
const g = G.pieceGeom(curved);
ok(g.cut && g.cut.length > 20, `vendored Maker flattens the curve (${g.cut && g.cut.length} cut pts, expect >20)`);
ok(!!g.seam, "curved piece still produces a seam line (uniform offset) under the vendored bundle");

// the full seeded-bodice shape (8 nodes, 3 curves, a dart, seam allowance) flattens without throwing
const bodice = { id: "p", name: "Bodice", count: 1, closed: true, seamMm: 12,
  nodes: [{ x: 50, y: 0 }, { x: 440, y: 0 }, { x: 490, y: 230 }, { x: 452, y: 420 }, { x: 311, y: 400 }, { x: 179, y: 400 }, { x: 38, y: 420 }, { x: 0, y: 230 }],
  edges: { "2": { curve: { type: "quad", cp: [0.5, 0.16] } }, "4": { curve: { type: "quad", cp: [0.5, 0.28] } }, "6": { curve: { type: "quad", cp: [0.5, 0.16] } } },
  darts: [{ id: "d", edge: 0, center: 0.5, width: 26, depth: 120, kind: "wedge" }] };
let threw = false, bcut = 0;
try { bcut = G.pieceGeom(bodice).cut.length; } catch (_) { threw = true; }
ok(!threw && bcut > 30, `seeded-bodice shape flattens under the vendored bundle (threw=${threw}, ${bcut} cut pts)`);

// a drafted set-in SLEEVE (two CUBIC cap edges) flattens under the vendored bundle — npm makerjs
// bundles bezier-js so the other tests can't prove the BROWSER cubic path; this can.
{
  const r = G.draftSleeve({ armholeFrontMm: 197, armholeBackMm: 197, capEaseFrac: 0.06 });
  let sthrew = false, scut = 0, sseam = false;
  try { const g = G.pieceGeom(r.piece); scut = g.cut.length; sseam = !!g.seam; } catch (_) { sthrew = true; }
  ok(!sthrew && scut > 40, `sleeve cap cubics flatten under the vendored bundle (threw=${sthrew}, ${scut} cut pts)`);
  ok(sseam, "drafted sleeve still produces a seam line (curved-cap offset) under the vendored bundle");
}

// DEGRADE-NEVER-BLANK: remove the Bezier global → BezierCurve throws → pieceGeom must fall back to
// straight edges (NOT throw, which is what blanked the editor before the fix).
const savedBezier = global.Bezier; global.Bezier = undefined;
let degradeThrew = false, dcut = 0;
try { dcut = G.pieceGeom(curved).cut.length; } catch (_) { degradeThrew = true; }
ok(!degradeThrew, "missing Bezier global → pieceGeom degrades, does NOT throw (no blank editor)");
ok(dcut > 0 && dcut <= 8, `degraded curve falls back to a straight cut (${dcut} pts, ~5)`);
global.Bezier = savedBezier;

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
