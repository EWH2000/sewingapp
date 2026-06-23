// verify-seed-bodice.mjs — sanity for the seeded garment geometry (tools/seed-examples.mjs): every
// inter-piece seam's two edges match in length (so they zip without strain — catches the shoulder
// mis-pairing + any taper drift), the bodice circumference fits the DEFAULT body (not the old
// child-size 520 mm that gaped on the form), and each example still lowers to a schema-3 print doc.
// Imports the seed's builders; the seed guards its POST behind an entry-point check, so importing
// is side-effect-free (no network).
//
//   cd ~/sewingapp/tools/preview && node verify-seed-bodice.mjs
import { bodice, EXAMPLES, G } from "../seed-examples.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const edgeLen = (nodes, e) => { const a = nodes[e], b = nodes[(e + 1) % nodes.length]; return Math.hypot(a.x - b.x, a.y - b.y); };

console.log("=== inter-piece seam edges match in length (zip without strain) ===");
for (const ex of EXAMPLES) {
  const byId = {}; ex.pieces.forEach((p) => { byId[p.id] = p; });
  for (const s of ex.seams) {
    if (s.a.piece === s.b.piece) continue;     // self-seam (sleeve underarm) — not an inter-piece zip
    if (s.ease) continue;                       // an EASED seam (a sleeve cap into its armhole) is meant NOT to match — verify-seed-sleeve.mjs checks those
    const A = byId[s.a.piece], B = byId[s.b.piece];
    // arc length (honors curved edges) so a curved seam zip is measured truly, not by its chord.
    const la = G.edgeArcLenMm(A, s.a.edge), lb = G.edgeArcLenMm(B, s.b.edge);
    ok(Math.abs(la - lb) <= 2, `${ex.name}: ${s.a.piece}.e${s.a.edge}(${la.toFixed(0)}) ↔ ${s.b.piece}.e${s.b.edge}(${lb.toFixed(0)}) match within 2mm`);
  }
}

console.log("=== the bodice fits the default body (not the old 520mm child-size) ===");
{
  const b = bodice();
  const width = (nodes) => Math.max(...nodes.map((n) => n.x)) - Math.min(...nodes.map((n) => n.x));
  const bustCirc = b.pieces.reduce((s, p) => s + width(p.nodes), 0);
  ok(bustCirc >= b.body.bustMm && bustCirc <= b.body.bustMm + 140,
    `bodice bust circ ${bustCirc}mm = body ${b.body.bustMm} + sane ease`);
}

console.log("=== each example still lowers to a schema-3 print doc (print spine intact) ===");
for (const ex of EXAMPLES) {
  const doc = G.freeformToDoc({ name: ex.name, pieces: ex.pieces, seams: ex.seams, body: ex.body, gridMm: 5 });
  const cuts = (doc.paths || []).filter((p) => p.kind === "cut").length;
  ok(doc.schema === 3 && cuts > 0 && doc.seams.length === ex.seams.length,
    `${ex.name}: schema ${doc.schema}, ${cuts} cut paths, ${doc.seams.length}/${ex.seams.length} seams`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
