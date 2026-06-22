// seed-examples.mjs — author the three M5 example garments (A-line skirt, sleeveless tank
// bodice, tank dress) and POST them to the running sewingapp, idempotently (skip a name that
// already exists). They are schema-3 freeform docs (pieces + seams + curves + darts + body) that
// PRINT 1:1 today and become the drape corpus once M5b/M5c land. Existing bags are untouched.
//
// Runs on the HOST (the container has no node): it evals the browser pattern-geom.js with the
// vendored Maker.js (npm copy in tools/tiling/node_modules) to flatten curves/darts to the exact
// `paths` the editor would store, then POSTs the full doc. The host CAN reach the container port.
//
//   node tools/seed-examples.mjs                 # → http://127.0.0.1:8006
//   SEWING_BASE=http://127.0.0.1:8006 node tools/seed-examples.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/ehill/sewingapp/tools/tiling/");
const makerjs = require("makerjs");
global.window = { makerjs };
eval(readFileSync("/home/ehill/sewingapp/app/static/js/pattern-geom.js", "utf8"));
const G = global.window.PatternGeom;
const BASE = process.env.SEWING_BASE || "http://127.0.0.1:8006";

// ── helpers ───────────────────────────────────────────────────────────────────
const N = (x, y, extra) => Object.assign({ x, y }, extra || {});               // node
const curve = (cp) => ({ curve: { type: "quad", cp } });                       // quad edge-local cp [u,v]
const DEFAULT_BODY = { heightMm: 1650, bustMm: 920, waistMm: 740, hipMm: 980 };

// ── 1. A-line skirt: two flared panels + a waistband; side seams (waist + hem open) ──
function skirt() {
  // y=0 hem (bottom), y=650 waist (top). Hem wider than waist → A-line flare.
  const panel = (id, name, role) => ({
    id, name, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes: [N(0, 0), N(560, 0), N(470, 650), N(90, 650)],   // e0 hem, e1 right side, e2 waist, e3 left side
  });
  const front = panel("sk_front", "Skirt Front", "front");
  const back = panel("sk_back", "Skirt Back", "back");
  const band = { id: "sk_band", name: "Waistband", count: 1, seamMm: 12, closed: true,
    nodes: [N(0, 0), N(780, 0), N(780, 70), N(0, 70)] };   // ≈ front+back waist, cut-on-fold height
  return {
    name: "Example — A-line Skirt", body: Object.assign({}, DEFAULT_BODY),
    pieces: [front, back, band],
    seams: [
      { a: { piece: "sk_front", edge: 1 }, b: { piece: "sk_back", edge: 3 } },  // right side seam
      { a: { piece: "sk_front", edge: 3 }, b: { piece: "sk_back", edge: 1 } },  // left side seam
    ],
  };
}

// ── 2. Sleeveless tank bodice: front + back, curved neckline + armholes, a waist dart ──
// 8 nodes: waist-L, waist-R, underarm-R, shoulder-R, neck-R, neck-L, shoulder-L, underarm-L.
// e0 waist, e1 R-side(sewn), e2 R-armhole(curve,open), e3 R-shoulder(sewn), e4 neckline(curve,open),
// e5 L-shoulder(sewn), e6 L-armhole(curve,open), e7 L-side(sewn).
// Sized to the DEFAULT body (bust 920, waist 740): symmetric taper about the panel centre (245),
// waist 390 + bust 490 per panel → front+back = waist 780 / bust 980 (a woven ease that closes on
// the dress form — front+back used to be 520 mm, child-sized on an adult form → side seams gaped).
function bodicePiece(id, name, role, { neckDip, dart }) {
  const nodes = [
    N(50, 0), N(440, 0),              // waist L, R (390 wide, centred on 245)
    N(490, 230), N(452, 420),         // underarm R (bust 490), shoulder R
    N(311, 400), N(179, 400),         // neck R, neck L (neck gap 132)
    N(38, 420), N(0, 230),            // shoulder L, underarm L
  ];
  const p = {
    id, name, count: 1, seamMm: 12, closed: true, place3d: { role },
    nodes,
    // armholes scoop inward + neckline dips toward the waist. For these edge directions the
    // edge-local left-normal points toward the body centre, so POSITIVE v bows inward (bbox-verified).
    edges: { "2": curve([0.5, 0.16]), "4": curve([0.5, neckDip]), "6": curve([0.5, 0.16]) },
  };
  if (dart) p.darts = [{ id: "d_waist", edge: 0, center: 0.5, width: 26, depth: 120, kind: "wedge" }];
  return p;
}
function bodice() {
  const front = bodicePiece("bo_front", "Bodice Front", "front", { neckDip: 0.28, dart: true });
  const back = bodicePiece("bo_back", "Bodice Back", "back", { neckDip: 0.10, dart: false });
  return {
    name: "Example — Tank Bodice", body: Object.assign({}, DEFAULT_BODY),
    pieces: [front, back],
    seams: [
      // The back wraps mirror-image of the front, so the shoulders CROSS (front-R ↔ back-L) just like
      // the sides do — pairing e3↔e3 put the two shoulders on opposite sides of the body (270 mm apart).
      { a: { piece: "bo_front", edge: 3 }, b: { piece: "bo_back", edge: 5 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] }, // R shoulder (front R ↔ back L)
      { a: { piece: "bo_front", edge: 5 }, b: { piece: "bo_back", edge: 3 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] }, // L shoulder (front L ↔ back R)
      { a: { piece: "bo_front", edge: 1 }, b: { piece: "bo_back", edge: 7 } }, // R side
      { a: { piece: "bo_front", edge: 7 }, b: { piece: "bo_back", edge: 1 } }, // L side
    ],
  };
}

// ── 3. Tank dress (flagship): bodice + skirt joined at the waist ──
function dress() {
  const bf = bodicePiece("dr_bf", "Dress Bodice Front", "front", { neckDip: 0.28, dart: true });
  const bb = bodicePiece("dr_bb", "Dress Bodice Back", "back", { neckDip: 0.10, dart: false });
  // skirt panels whose WAIST edge (e2, top) = the new bodice waist width (390) so the waist seam zips;
  // hem flares to 760/panel (A-line) so the skirt clears the hip (980) below the waist. y=0 hem, y=560 waist.
  const sf = { id: "dr_sf", name: "Dress Skirt Front", count: 1, seamMm: 12, closed: true, place3d: { role: "front-skirt", wrap: "front" },
    nodes: [N(0, 0), N(760, 0), N(575, 560), N(185, 560)] };   // e0 hem(760), e1 R, e2 waist(390), e3 L
  const sb = { id: "dr_sb", name: "Dress Skirt Back", count: 1, seamMm: 12, closed: true, place3d: { role: "back-skirt", wrap: "back" },
    nodes: [N(0, 0), N(760, 0), N(575, 560), N(185, 560)] };
  return {
    name: "Example — Tank Dress", body: Object.assign({}, DEFAULT_BODY),
    pieces: [bf, bb, sf, sb],
    seams: [
      { a: { piece: "dr_bf", edge: 3 }, b: { piece: "dr_bb", edge: 5 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] }, // R shoulder (front R ↔ back L)
      { a: { piece: "dr_bf", edge: 5 }, b: { piece: "dr_bb", edge: 3 }, anchors: [{ ta: 0, tb: 1 }, { ta: 1, tb: 0 }] }, // L shoulder (front L ↔ back R)
      { a: { piece: "dr_bf", edge: 1 }, b: { piece: "dr_bb", edge: 7 } }, // bodice R side
      { a: { piece: "dr_bf", edge: 7 }, b: { piece: "dr_bb", edge: 1 } }, // bodice L side
      { a: { piece: "dr_sf", edge: 1 }, b: { piece: "dr_sb", edge: 3 } }, // skirt R side
      { a: { piece: "dr_sf", edge: 3 }, b: { piece: "dr_sb", edge: 1 } }, // skirt L side
      { a: { piece: "dr_bf", edge: 0 }, b: { piece: "dr_sf", edge: 2 }, ease: 0.0 }, // front waist join
      { a: { piece: "dr_bb", edge: 0 }, b: { piece: "dr_sb", edge: 2 }, ease: 0.0 }, // back waist join
    ],
  };
}

// ── build + POST ────────────────────────────────────────────────────────────────
const EXAMPLES = [skirt(), bodice(), dress()];
export { skirt, bodice, dress, bodicePiece, EXAMPLES, G };   // for tools/preview/verify-seed-bodice.mjs

async function main() {
  // Default: idempotent skip-by-name (create only what's missing). SEED_OVERWRITE=1 UPDATES an
  // existing example in place by its id (e.g. after a geometry fix), preserving id 5/6/7.
  const overwrite = process.env.SEED_OVERWRITE === "1";
  let byName;
  try {
    const r = await fetch(`${BASE}/patterns`);
    if (!r.ok) throw new Error(`GET /patterns → ${r.status}`);
    byName = new Map((await r.json()).map((p) => [p.name, p.id]));
  } catch (e) {
    console.error(`Couldn't reach ${BASE} (${e.message}). Is the container running + rebuilt with the GET /patterns route?`);
    process.exit(1);
  }
  let created = 0, updated = 0, skipped = 0, failed = 0;
  for (const ex of EXAMPLES) {
    const existingId = byName.get(ex.name);
    if (existingId != null && !overwrite) { console.log(`skip   "${ex.name}" (already exists; SEED_OVERWRITE=1 to update)`); skipped++; continue; }
    const doc = G.freeformToDoc({ name: ex.name, pieces: ex.pieces, seams: ex.seams, body: ex.body, gridMm: 5 });
    // sanity: every example must lower to a schema-3 doc with real print paths + carried seams.
    const cuts = (doc.paths || []).filter((p) => p.kind === "cut").length;
    if (doc.schema !== 3 || !cuts || doc.seams.length !== ex.seams.length) {
      console.error(`BUILD FAIL "${ex.name}": schema=${doc.schema} cuts=${cuts} seams=${doc.seams.length}/${ex.seams.length}`); failed++; continue;
    }
    try {
      const payload = { name: ex.name, kind: "freeform", params: doc };
      if (existingId != null) payload.id = existingId;   // update in place (preserve the id)
      const r = await fetch(`${BASE}/patterns`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(`POST → ${r.status}`);
      const d = await r.json();
      console.log(`${existingId != null ? "update" : "create"} "${ex.name}" → id ${d.id} (${doc.pieces.length} pieces, ${cuts} cut paths, ${doc.widthMm}×${doc.heightMm}mm)`);
      if (existingId != null) updated++; else created++;
    } catch (e) { console.error(`POST FAIL "${ex.name}": ${e.message}`); failed++; }
  }
  console.log(`\n${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

// Run only as the entry point — importing this module (verify-seed-bodice.mjs) must NOT POST.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
