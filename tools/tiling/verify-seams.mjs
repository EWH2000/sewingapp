// verify-seams.mjs — headless tests for the schema-3 seam graph (M2 data model).
// Same window-shim bootstrap as verify-editor-geom.mjs: eval the browser modules in Node.
//   cd ~/sewingapp/tools/tiling && node verify-seams.mjs

import * as PDFLib from "pdf-lib";
import makerjs from "makerjs";
import { readFileSync } from "node:fs";
import assert from "node:assert";

global.window = { PDFLib, makerjs };
const ROOT = "/home/ehill/sewingapp/app/static/js";
eval(readFileSync(`${ROOT}/pattern-pdf.js`, "utf8"));
eval(readFileSync(`${ROOT}/pattern-geom.js`, "utf8"));
const G = global.window.PatternGeom;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log("  ok:", m); pass++; };

// A 4-node rectangle piece (edges 0..3 = bottom, right, top, left).
const rect = (id, name, x = 0, y = 0, w = 200, h = 100) => ({
  id, name, count: 1, seamMm: 0, cornerRadius: 0, closed: true,
  nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
  layout: { x: 0, y: 0 },
});

console.log("=== schema bump + carry-through ===");
const front = rect("p_front", "Front"), back = rect("p_back", "Back", 240);
let doc = G.freeformToDoc({ pieces: [front, back], name: "Two panels" });
ok(doc.schema === 2, "no seams -> schema stays 2 (back-compat)");
ok(Array.isArray(doc.seams) && doc.seams.length === 0, "seams defaults to []");

const withSeam = G.freeformToDoc({
  pieces: [rect("p_front", "Front"), rect("p_back", "Back", 240)],
  seams: [{ a: { piece: "p_front", edge: 1 }, b: { piece: "p_back", edge: 3 }, foldAngle: 90 }],
  name: "Sewn",
});
ok(withSeam.schema === 3, "a seam present -> schema bumps to 3");
ok(withSeam.seams.length === 1, "the seam is carried into the doc");
ok(withSeam.seams[0].id && /^s\d+$/.test(withSeam.seams[0].id), "seam got a generated id");
ok(withSeam.seams[0].a.piece === "p_front" && withSeam.seams[0].a.edge === 1, "EdgeRef a preserved");
ok(withSeam.seams[0].foldAngle === 90, "foldAngle preserved");
ok(withSeam.paths.some((p) => p.kind === "cut"), "print paths still emitted (tiler unaffected)");

console.log("=== back-compat: legacy docs still load ===");
ok(G.normalizePieces({ nodes: rect("x", "x").nodes }).length === 1, "schema-1 single `nodes` -> one piece");
ok(G.normalizePieces({ pieces: [rect("a", "A"), rect("b", "B", 240)] }).length === 2, "schema-2 pieces load");
const noSeams = G.freeformToDoc({ pieces: [rect("a", "A")] });   // schema-2 doc, no seams key
ok(noSeams.schema === 2 && noSeams.seams.length === 0, "schema-2 doc (no seams key) loads, seams:[]");

console.log("=== unique + stable piece ids ===");
// Two pieces where one already claims the positional default id of the other.
const ids = G.normalizePieces({ pieces: [{ id: "p2", name: "A", nodes: rect("_", "_").nodes }, { name: "B", nodes: rect("_", "_").nodes }] }).map((p) => p.id);
ok(new Set(ids).size === 2, `piece ids are unique (got ${JSON.stringify(ids)})`);
ok(ids.includes("p2"), "an existing explicit id is preserved");

console.log("=== normalizeSeams drops dangling refs ===");
const pieces = G.normalizePieces({ pieces: [rect("p_front", "Front"), rect("p_back", "Back", 240)] });
const cleaned = G.normalizeSeams([
  { a: { piece: "p_front", edge: 1 }, b: { piece: "p_back", edge: 3 } },  // valid
  { a: { piece: "p_front", edge: 1 }, b: { piece: "p_GONE", edge: 0 } },  // missing piece
  { a: { piece: "p_front", edge: 9 }, b: { piece: "p_back", edge: 0 } },  // edge out of range
], pieces);
ok(cleaned.length === 1, "only the valid seam survives (dangling refs dropped)");

console.log("=== edge-identity stability ===");
// Edge ref must keep pointing at the same node-edge after a node move + a cornerRadius change.
const p0 = rect("p_front", "Front");
const seam0 = [{ id: "s_keep", a: { piece: "p_front", edge: 2 }, b: { piece: "p_back", edge: 0 } }];
const moved = JSON.parse(JSON.stringify(p0));
moved.nodes[0].x -= 35; moved.nodes[2].y += 22; moved.cornerRadius = 12;   // move nodes + round corners
const after = G.normalizeSeams(seam0, [moved, rect("p_back", "Back", 240)]);
ok(after.length === 1 && after[0].a.edge === 2 && after[0].a.piece === "p_front",
   "seam still references edge 2 of p_front after node-move + radius change");

console.log("=== round-trip (load -> save -> load) ===");
const again = G.freeformToDoc({ pieces: withSeam.pieces, seams: withSeam.seams, name: withSeam.name });
ok(again.schema === 3 && again.seams.length === 1 && again.seams[0].id === withSeam.seams[0].id,
   "seams + schema survive a second freeformToDoc round-trip (stable id)");

console.log("=== M5a: edge identity stable under curve edit / dart add / node move ===");
{
  // a seam on edge 2; then add a curve to edge 0, a dart to edge 1, and move node 0.
  const base = rect("p_front", "Front");
  const keep = [{ id: "s_keep", a: { piece: "p_front", edge: 2 }, b: { piece: "p_back", edge: 0 } }];
  const edited = JSON.parse(JSON.stringify(base));
  edited.edges = { "0": { curve: { type: "quad", cp: [0.5, 0.15] } } };   // edge 0 → curve
  edited.darts = [{ id: "d1", edge: 1, center: 0.5, width: 20, depth: 40, kind: "wedge" }];  // dart on edge 1
  edited.nodes[0].x -= 40; edited.nodes[0].y -= 15;                        // move node 0
  const norm = G.normalizePieces({ pieces: [edited, rect("p_back", "Back", 240)] });
  const after = G.normalizeSeams(keep, norm);
  ok(after.length === 1 && after[0].a.edge === 2 && after[0].a.piece === "p_front",
     "seam still references edge 2 after a curve edit + dart add + node move (no silent retarget)");
  ok(!!norm[0].edges && !!norm[0].edges["0"], "curve survived normalize (edges carried)");
  ok(Array.isArray(norm[0].darts) && norm[0].darts.length === 1, "dart survived normalize (darts carried)");
}

console.log("=== M5a: schema-3 fields carry + bump independently of seams ===");
{
  // a dart alone (no user seam) still bumps the doc to schema 3.
  const d = G.freeformToDoc({ name: "Just a dart", pieces: [Object.assign(rect("p", "P"),
    { darts: [{ id: "d1", edge: 0, center: 0.5, width: 20, depth: 40, kind: "wedge" }] })] });
  ok(d.schema === 3, "a dart (no seam) bumps schema to 3");
  ok(d.pieces[0].darts && d.pieces[0].darts.length === 1, "dart round-trips through freeformToDoc");
  // ease/gather on a user seam survive normalization.
  const g = G.freeformToDoc({ pieces: [rect("p_front", "Front"), rect("p_back", "Back", 240)],
    seams: [{ a: { piece: "p_front", edge: 1 }, b: { piece: "p_back", edge: 3 }, ease: 0.12,
      gather: { type: "gather", ratio: 2, region: [0.2, 0.8] } }] });
  ok(g.seams[0].ease === 0.12, "seam.ease preserved");
  ok(g.seams[0].gather && g.seams[0].gather.ratio === 2, "seam.gather preserved");
}

console.log("=== M5a: legacy {x,y} notch migrates on save, schema-1/2 still load ===");
{
  const legacy = Object.assign(rect("p", "P"), { notches: [{ x: 200, y: 50 }] });   // {x,y} on the right edge
  // load (normalizePieces) must NOT destroy it
  const loaded = G.normalizePieces({ pieces: [legacy] })[0];
  ok(loaded.notches[0].x === 200 && loaded.notches[0].y === 50, "load preserves legacy {x,y} notch (non-destructive)");
  // save (freeformToDoc) migrates it to {edge,t,type}
  const saved = G.freeformToDoc({ pieces: [legacy] });
  const nt = saved.pieces[0].notches[0];
  ok(Number.isInteger(nt.edge) && typeof nt.t === "number" && nt.type === "single",
     `notch migrated on save → {edge:${nt.edge}, t:${nt.t}, single}`);
  ok(nt.edge === 1, "migrated notch lands on the right edge (edge 1)");
  // schema-1 single `nodes` doc still loads + the doc is schema-2 clean (no garment fields)
  const s1 = G.freeformToDoc({ nodes: rect("x", "x").nodes, seamMm: 8 });
  ok(s1.schema === 2 && s1.pieces.length === 1 && !s1.body, "schema-1 doc still loads as one piece, schema 2");
}

console.log(`\nALL PASS — ${pass} checks`);
