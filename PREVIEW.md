# PREVIEW.md — assembled 3D preview (the road to garment drape)

> Self-contained build spec for adding an **assembled 3D preview** to `~/sewingapp/`.
> Companions: `DESIGN.md` (architecture spine + locked decisions, the JSON document
> model), `PRINTING.md` (the print spine this MUST NOT touch). Server-wide rules:
> `~/CLAUDE.md`.
>
> **Status: PLAN ONLY — nothing here is built yet.** This is the blueprint written
> *before* any code, deliberately, because the destination (soft-body garment drape)
> is hard enough that the on-ramp has to be designed end-to-end first. Every library
> name, version, license, and file size below was verified against current (2026)
> sources; every claim about *our* code is grounded in the real
> `app/static/js/pattern-geom.js`, `editor.js`, `base.html`, `edit.html`, and
> `main.py`. Where a number is an estimate (iPad sim budget, effort), it says so.

---

## 1. Purpose & the bright line

Today the app authors flat pattern pieces and prints them 1:1. The partner has to
**hold the pieces in her head** — imagine how front + back + sides + base fold and
sew into a boxy tote, or how a bodice front and back drape into a dress. The
assembled 3D preview closes that gap: tap **"Preview"**, see the *sewn-up thing* in
3D, orbit it, sanity-check the shape before cutting fabric.

There is one bright line that organizes the entire feature, and getting it wrong is
the way this becomes a swamp:

> **Structured things are CONSTRUCTED geometrically. Draped things are SIMULATED.**

- A **boxy tote** is a *constructed* object: its panels are rigid-ish, they meet at
  sharp seams, and the 3D shape is **implied by the geometry** — you can fold it up
  with matrix math, no physics. This is cheap, deterministic, and headless-testable.
- A **dress** is a *draped* object: flat panels sewn at seams, then **gravity +
  collision against a body** decide the shape. There is no closed-form answer; you
  must relax a cloth simulation. This is expensive, stochastic, and only verifiable
  by eye.

**The real goal is the draped case** — the partner is already attempting dresses,
and a fold-up preview that only works for boxes would miss the point. But you do not
start by writing a cloth solver. You start by building the **seam graph** — the
explicit "edge X of piece A is sewn to edge Y of piece B" data — because *both* the
rigid fold-up and the cloth drape are driven by exactly that graph. Steps 1 and 2
are the deliberate on-ramp that builds and proves the shared foundation Step 3 needs;
Step 3 is the destination. She is willing to work through the hard patches to get
there. This document plans all three so the early code doesn't have to be thrown away.

The three steps, and which side of the bright line each lives on:

| Step | What it previews | Side of the line | New machinery |
|---|---|---|---|
| **1 — Box preview** | the boxy tote, from its known parameters | constructed (trivial) | three.js loaded no-build; `docToMesh` |
| **2 — Rigid fold-up** | *any* multi-piece bag, from an explicit seam graph | constructed (real) | **the seam graph**; spanning-tree fold + closure solve |
| **3 — Cloth drape** | garments (and inflated bags) on a body form | **simulated (the goal)** | XPBD cloth; triangulation; body form; stitch constraints |

Each step is independently useful and ships on its own. Step 1 validates the loader
on the iPad with zero physics. Step 2 produces the seam graph and a complete rigid
fold — and that fold is the *warm start* Step 3's cloth solver needs to not explode.
Nothing is wasted.

---

## 2. Where it lives & the architecture

### 2.1 The invariants this feature inherits (non-negotiable)

The preview is a new consumer bolted onto the existing spine; it changes none of it.

- **Browser-side geometry, always.** Mesh building, folding, and cloth simulation
  all run in the browser, exactly like PDF generation does (`pattern-pdf.js`) and
  geometry does (`pattern-geom.js`). See §2.4 for why server-side 3D is rejected.
- **No build step, no bundler.** Vendored single files, page-scoped `<script>` /
  import map — the box's "drop files & refresh" convention (`DESIGN.md` locked
  decision: *"Vendored ESM, no build step — for now"*). three.js loads via a native
  import map; the Step-3 cloth solver is **hand-rolled pure JS** (§6.1) and `poly2tri`
  vendors as a single file, so **no WASM and no bundler enter the core path**. This is
  deliberate: `DESIGN.md` records a build-step trigger — *"add a build step (Vite/
  esbuild) when we embed FreeSewing `@freesewing/core` … its dependency graph makes
  hand-vendoring impractical."* By hand-rolling the solver and vendoring three.js/
  poly2tri as single files instead of pulling in FreeSewing, **the garments era arrives
  here without tripping that trigger** — the no-build convention survives Step 3. No
  Vite, no esbuild, no `es-module-shims`.
- **The server stays a dumb store + relay.** It persists the opaque `params_json`
  (SQLite, backed up) and relays PDFs over IPP (`printing.py`). It learns **nothing**
  about seams, meshes, or drape. The schema bump is invisible to it because
  `params_json` is opaque text (§3.5).
- **The print spine is untouched.** `pattern-pdf.js`, the tiler, `printing.py`, and
  the calibration gate are not modified. Every new authoring feature still *lowers*
  to the existing `cut`/`seam` line-kinds before `freeformToDoc` builds `paths`, so
  the printed pattern is exactly what it is today. The 3D preview is **read-only** of
  the same document; it never feeds the printer.
- **iPad-friendly.** The partner authors on an iPad. Touch orbit, a budget that
  holds on an M-class tablet single core, native import maps (Safari 16.4+).
- **Headless geometry tests in `tools/`.** The deterministic parts (mesh build, fold
  math, triangulation, edge correspondence) get `.mjs` tests like the existing
  `tools/tiling/verify-editor-geom.mjs`. The non-deterministic parts (drape look,
  drag UX) are verified by hand (§7).

### 2.2 The no-build load pattern (concrete)

three.js is **ESM-only** as of r160 (the UMD `three.min.js` global build was removed;
pinning a UMD build means freezing at r159, a 2023-era three.js missing every
WebGPU/material fix the cloth roadmap will want — rejected). The modern delivery is a
**native browser import map**, universally supported on the target devices (Chrome
89+, **Safari 16.4+ / iOS 16.4+**, Firefox 108+), so no `es-module-shims` shim is
needed. The current release is **three r184 (`0.184.0`, MIT)**; `build/three.module.js`
is ~634 KB raw / **~126 KB gzip** (un-minified is fine over the LAN — if you ever want
it smaller, run Terser once at vendor-time, not as a build step). `OrbitControls`
(MIT, ships in `examples/jsm/controls/OrbitControls.js`) is ~40 KB / 8.4 KB gzip.

Vendor layout (mirror the `examples/jsm/` tree exactly — addons import each other by
relative path, and bare `'three'` resolves via the map):

```
app/static/js/vendor/three/
  three.module.js                       # 0.184.0 build/three.module.js, vendored as-is
  addons/
    controls/OrbitControls.js           # from the SAME 0.184.0 tag
```

The preview gets its **own page** (`/preview/{id}`), and that page's `head_extra`
loads three.js — the same gating pattern by which Maker.js is loaded only on `/edit`.
The import map must be inline (`type="importmap"` forbids `src`/`defer`/`async`) and
must come **before** the module script that uses it (the safe ordering on every
browser, incl. the old Firefox importmap-preload bug):

```jinja
{# app/templates/preview.html — extends base.html #}
{% block head_extra %}
  <script>window.SEWING_PREVIEW = {{ (pattern or {})|tojson }};</script>
  <script type="importmap">
  {
    "imports": {
      "three": "{{ base_path }}/static/js/vendor/three/three.module.js?v={{ asset_ver }}",
      "three/addons/": "{{ base_path }}/static/js/vendor/three/addons/"
    }
  }
  </script>
  <script type="module" src="{{ base_path }}/static/js/preview.js?v={{ asset_ver }}"></script>
{% endblock %}
```

```js
// app/static/js/preview.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const doc = window.SEWING_PREVIEW || {};      // same injection channel as window.SEWING_EDIT on /edit
// ...build scene, mesh from doc, OrbitControls (touch pinch/orbit built in)...
```

**Coexistence is clean.** An import map only rewrites *bare specifiers inside
`type="module"` scripts*. It does not touch `base.html`'s classic `defer` scripts
(`pdf-lib.min.js`, `pattern-pdf.js`, `app.js`) or their `window.*` globals — those
live in a separate resolution world. The preview module still reads `window.SEWING_*`
freely (classic → module globals cross fine). There is deliberately **no
`window.THREE`** and **no three-shim** — that's the inverted, classic-bundle pattern
Maker.js needs (`maker-shim.js`), wrong for a real ESM library. `preview.js` imports
by name.

**Cache-busting:** `_compute_asset_ver()` (`main.py` ~L45) hashes the bytes of every
`.js`/`.css` under `static/`, so dropping the vendored files in **auto-rolls them into
`ASSET_VER`** with no code change. Put `?v={{ asset_ver }}` on the `"three"` map
*value* (a normal URL). The `"three/addons/"` *prefix* can't cleanly carry a query
(`?v=` mangles the appended path), so addons rely on `ASSET_VER` flipping on every
deploy plus the rule below — fine, because you vendor addons once and never touch
them in isolation. **Pinning discipline (load-bearing):** `three.module.js` and every
`examples/jsm/*` file MUST come from the **same release tag** — mixing an r184 core
with an r180 addon throws at runtime. Vendor them as a set; document it in a
`vendor/three/README`.

### 2.3 Per-page gating (mirrors the Maker.js precedent)

`base.html` loads the always-on classic stack (pdf-lib → pattern-pdf → app.js).
`edit.html` is the only page that fills `head_extra` today, loading the editor-only
classic stack (browser.maker.js → maker-shim → pattern-geom → editor). The preview is
one page further out:

| Page | pdf-lib | Maker.js (~427 KB) | three.js (~126 KB gz) | cloth solver |
|---|---|---|---|---|
| Home / index | ✅ | ❌ | ❌ | ❌ |
| `/edit` (Draw) | ✅ | ✅ | ❌ | ❌ |
| `/preview/{id}` (new) | ✅ | ✅ | ✅ | ✅ pure-JS XPBD + poly2tri (Step 3) |

The iPad authoring/printing flows stay exactly as fast as today; the 3D libs are paid
for only when she taps "Preview". The Step-3 "cloth solver" column is **pure JS**
(`pattern-cloth.js` + the small `poly2tri` vendor) — no WASM blob (§6.1). **The preview
page loads the same classic geom stack as `/edit`** (browser.maker.js → maker-shim →
pattern-geom, `defer`, *before* the import map + module), so `G.pieceGeom(piece)` is
the **single source of truth** for the flattened `{cut, seam}` outlines shared by print
*and* preview (§2.5) — without it `pieceGeom` silently degrades to straight lines (no
fillets/curves/seam). The classic globals and the ESM `preview.js` coexist cleanly
(§2.2): the import map only rewrites bare specifiers inside `type="module"` scripts.

### 2.4 Separate page/module vs separate service — and why not server-side 3D

**Recommendation: the preview is a separate PAGE in the same app (`/preview/{id}`),
and Step 3's cloth engine is a separate JS MODULE (its own files) loaded only on that
page — NOT a separate service.**

Reasons:
- **Same app, same origin, same store.** The preview reads the same `Pattern`
  document the editor saves. A separate service would mean duplicating auth, the
  `BASE_PATH`/Caddy wiring, the SQLite access, and the backup story for zero benefit —
  the box already has eight services; this is not a ninth.
- **A separate *page* (not a tab inside `/edit`)** keeps three.js + physics off the
  editor, mirrors the Maker.js gating exactly, and gives the heavy 3D view its own
  full-screen canvas without fighting the editor's SVG layout. A "Preview" entry
  joins the tab bar (`base.html`), and `/edit` grows a "Preview →" button.
- **Step 3 as its own module is wise** (and the owner agrees): `pattern-cloth.js`,
  `pattern-mesh.js`, `body-form.js`, `preview3d.js` are cleanly separable from the
  print/edit code, can be developed and tested in isolation, and can be disabled
  wholesale (the page simply doesn't load them) if the drape isn't ready. It is
  *linked from* the app, not woven through it.

**Server-side 3D is rejected, briefly:** no headless Blender, no GPU compute on the
box. (1) It violates the spine — geometry is browser-side, the server only stores +
relays. (2) This is a rootless-podman quadlet on a monitoring box with **no GPU
budget and no print/CUDA stack**; standing up headless Blender or a GPU cloth solver
is a large, stateful, root-touching detour for a household preview. (3) It would force
a second renderer/maintenance surface and break the "author on any device, the work is
in the doc" property. The browser already has WebGL/WebGPU on the iPad; use it.

### 2.5 How it consumes the document, touching nothing in the print path

The preview reads the **same `params_json` document** the editor produces — the
`pieces[]` array with `nodes`, `seamMm`, `cornerRadius`, `notches`, `placements`,
`layout`, plus the new `seams[]` graph and per-piece 3D hints (§3). It reuses
`window.PatternGeom` for the flattened outlines: `G.pieceGeom(piece)` already returns
the exact `{cut, seam}` polylines the tiler prints, flattened from fillets/curves via
Maker.js at chord-err ≤0.35 mm. **The preview triangulates / folds those very
polylines**, so the simulated edge and the cut edge are the same curve by construction.

The preview **never writes to `paths`/`labels`** and never calls the print endpoints.
The only thing it may write back to the document is a **settled-drape cache**
(§3.4, §6) — more opaque JSON that rides the existing CRUD untouched.

---

## 3. The data model (schema 2 → 3)

### 3.1 The seam graph is the keystone

Schema 2 (today) is a list of independent pieces with a board `layout`. The single
most important addition is a **top-level seam graph**: an explicit list of which edge
of which piece is sewn to which edge of which other piece. This is the data that:
- folds the bag up rigidly (Step 2: each seam is a hinge),
- stitches the cloth together (Step 3: each seam is a constraint),
- and matches the prior art — GarmentCode/pygarment (MIT), the closest research to
  "flat panels + stitch graph → drape," stores exactly this: panels are loops of
  *addressable directed edges*, and stitches are a list of `{panel, edge}` ↔
  `{panel, edge}` edge-pairs, with unequal edge lengths legal and resolved by
  arc-length resampling.

Everything else in this section hangs off the seam graph.

### 3.2 Edge identity — the hard problem, solved first

A seam, dart, or notch must point at "an edge." But our pieces are `nodes[]` that
`pieceGeom` *flattens* (fillets → arcs → many polyline segments; curves likewise). If
a seam referenced flattened-segment indices, a radius change would silently retarget
it. **Decision, copied into every new field:**

> Seams / darts / notches reference **authored node-edges**, never flattened segments,
> never raw coordinates. **Edge `i` = "the boundary edge leaving node `i`"** (segment
> `node[i] → node[i+1]`, modulo the closed loop) — the *exact* convention already used
> by `insertVertexOnEdge` and `nearestEdge` in `pattern-geom.js`.

This identity is stable across moving a node, changing a corner `radius`, toggling
seam allowance, turning an edge into a Bézier, and the shelf-packer's per-piece
translation — because everything is piece-local and a fillet only *shortens* an
edge's ends, it never changes which edge "leaves node `i`." A point on an edge is
addressed by **arc-length fraction** `t ∈ [0,1]` (the same `t` `projectPointOnSegment`
already returns), which is what makes notch correspondence and ease distribution land
at the same physical place on two unequal edges.

```
EdgeRef   = { piece: <pieceId>, edge: <int i> }      // "edge leaving node i"
EdgePoint = { piece, edge: i, t: <0..1> }            // t = fraction of that edge's arc length
```

Stable references require **stable piece ids** — `clonePiece` already assigns
`p.id || ("p"+(i+1))`. Promote that to a real slug on save so renaming/reordering a
piece can't silently retarget a seam (falling back to the array index for legacy docs).

### 3.3 Full field spec (additive; absent in every schema-2 doc)

All new fields are **optional** and default to `[]`/`null` exactly as `clonePiece`
already does for `notches`/`placements`. Bump `schema: 3` only when a new field is
actually present.

**Top-level seam graph (the new array):**

```jsonc
"seams": [
  {
    "id": "s_shoulder",
    "a": { "piece": "p_front", "edge": 2 },     // EdgeRef
    "b": { "piece": "p_back",  "edge": 2 },     // EdgeRef — a and b MAY differ in length
    "anchors": [ { "ta": 0.0, "tb": 1.0 }, { "ta": 1.0, "tb": 0.0 } ],  // matched notch pairs; opposite dir here
    "foldAngle": null,                          // Step 2 dihedral, deg: 0 flat, +valley, −mountain; null = solve
    "ease": 0.0,                                // Step 3: a is (1+ease)× longer than b, distribute smoothly
    "gather": null                              // Step 3: explicit gathers/pleats (3.3 gathers)
  }
]
```

- `a`/`b` are `EdgeRef`s; the two flattened edges **may differ in length** — that's
  legal and is the whole point (it's ease/gather). `anchors` pin corresponding
  arc-length fractions so the fold/drape resamples *between anchors* (segment-wise
  arc-length match). **The notches ARE the anchors:** a notch on edge a at `t=0.4`
  meeting a notch on edge b at `t=0.55` is one `{ta:0.4, tb:0.55}` entry — exactly how
  a sewist uses balance notches.
- `foldAngle` is Step 2's dihedral (FOLD spec convention: `[−180,180]°`, +valley,
  −mountain, 0 flat); `null` means "let the closure solver find it" (§5).
- `ease`/`gather` are Step 3 seam attributes (ease/gather is *relational* — a property
  of how a long edge distributes onto a short neighbor — so it lives on the seam, not
  the edge).

**Gathers / pleats (Step 3, on the seam):**

```jsonc
"gather": { "type": "gather", "ratio": 2.0, "region": [0.2, 0.8] }      // long:short ratio over a t-span of the SHORT edge
"gather": { "type": "pleat", "style": "knife", "count": 6, "depth": 30 } // discrete folds instead
```

Printed-pattern impact: none required (the long edge is already the right length); we
*may* emit gather balance-notches as existing `cut` ticks so she knows where to gather.
Drape impact: the solver resamples the long edge to the short edge's length within
`region`, leaving slack that buckles into folds — standard Marvelous-Designer/
GarmentCode gather semantics.

**Per-piece additions (curves, darts, variable SA, upgraded notches, 3D hints):**

```jsonc
{
  "id": "p_front", "name": "Bodice Front", "count": 1, "seamMm": 12, "closed": true,
  "nodes": [
    { "x": 0, "y": 0, "saMm": 14 },             // saMm: OPTIONAL per-node seam-allowance override (variable SA)
    { "x": 200, "y": 0 }, { "x": 200, "y": 300 }, { "x": 0, "y": 300 }
  ],
  "edges": {                                    // OPTIONAL sparse map keyed by start-node index (string)
    "2": { "curve": { "type": "quad", "cp": [0.5, 0.12] } }   // edge leaving node 2 is a curved neckline/armhole
  },
  "darts": [                                    // OPTIONAL
    { "id": "d_waist", "edge": 0, "center": 0.5, "width": 24, "depth": 90, "kind": "wedge" }
  ],
  "notches": [                                  // CHANGED shape (legacy {x,y} auto-converted)
    { "edge": 1, "t": 0.5, "type": "single" }
  ],
  "place3d": { "role": "side", "wrap": "front" },  // OPTIONAL Step 2/3 pre-placement hint (3.3 hints)
  "layout": { "x": 0, "y": 0 }                  // existing board placement (WYSIWYG) — unchanged
}
```

- **Curves** are stored as Bézier control data in the **edge-local frame** (chord =
  X axis, left-normal = Y), copying GarmentCode so the value is invariant to the
  shelf-packer's translation and to scale. `type:"quad"` (one control point) covers
  necklines/armholes; `cubic`/`arc` reserved with the same convention. `edges` is a
  **sparse object** keyed by start-node index — absent key ⇒ straight edge (today's
  behavior). Flattening to polyline happens once, in `pieceGeom`, at the same chord
  tolerance as fillets — so **print and drape agree because both consume one flatten**.
  (Faking curves with dense polygon nodes is rejected: it bloats the doc, makes every
  node draggable on the iPad, and destroys edge identity so seams/notches can't attach.)
- **Darts** are GarmentCode's model: a `wedge` dart splits edge `i` at
  `center ± width/2`, drops an apex vertex at `depth` into the interior, and the two
  new legs become the cut outline *plus* a self-`seam` (both sides on the same piece)
  that Step 2/3 sews shut — collapsing the dart and shaping the panel. A `slash` dart
  draws only interior fold lines. Both lower to the existing `cut`/`seam` line-kinds,
  so `pattern-pdf.js` is untouched.
- **Variable seam allowance** via optional `node.saMm` (e.g. wider at a hem),
  mirroring Valentina; absent ⇒ the piece `seamMm`.
- **Notches** upgrade to `{edge, t, type}` — stable under node moves and curve edits,
  carrying Seamly2D passmark identity (`single`/`double` — double marks "back" so a
  seam can't be sewn reversed). Legacy `{x,y}` notches load via the existing
  `nearestEdge` projection and convert on first save (no data loss).

**Document-level body measurements (Step 3 garments):**

```jsonc
"body": { "heightMm": 1650, "bustMm": 920, "waistMm": 740, "hipMm": 980 }
```

The four numbers a sewing pattern already needs; they parametrize the dress form
(§6.7). Absent ⇒ no body (bags don't need one).

### 3.4 The settled-drape cache (where Step 3's expensive result lives)

The drape is expensive-once; never recompute it on reopen. Cache the settled mesh in
the document (the server stores it as opaque JSON — no server change):

```jsonc
"preview3d": {
  "simVersion": 3,                  // engine version; mismatch ⇒ invalidate
  "geomHash": "…",                  // hash of pieces+seams; mismatch ⇒ invalidate
  "h": 20,                          // node spacing used (mm)
  "nodes": [ /* quantized Float positions, e.g. int16 @0.1mm */ ],
  "tris":  [ /* index buffer */ ],
  "pieceRanges": [ /* per-piece node spans */ ],
  "settledAt": "2026-…"
}
```

On open: if `simVersion` and `geomHash` match, load straight into a three.js
`BufferGeometry` and render instantly — zero simulation. Any edit to a piece/seam/
notch invalidates it and re-drapes lazily (only when the Preview page opens). A
4k-node mesh is ~24 KB raw, far less quantized — trivial next to the ~512 KB pdf-lib
already shipped, and it round-trips through CRUD + the nightly backup for free.

### 3.5 Backward-compat & round-trip

- **`schema: 3`**, set only when a schema-3 field is present. `normalizePieces`
  defaults `edges:{}`, `darts:[]`, upgrades `notches`, assigns ids — exactly how
  schema-1→2 was handled. Schema-1 (single `nodes`) and schema-2 (pieces, no seams)
  docs continue to load (one piece / a print-only doc with no seam graph).
- **Print path untouched:** `pieceGeom`/`pieceExtras` lower every new feature
  (curves, darts, notches) to `cut`/`seam` lines before `freeformToDoc` builds
  `paths`. `pattern-pdf.js`, the tiler, the calibration gate, and `printing.py` never
  learn about `seams`/`curve`/`darts`/`gather`/`preview3d`. The preview is their only
  consumer — which is why this lands incrementally without risking the proven print
  spine.

### 3.6 Worked JSON — a simple bag and a simple bodice

**(a) A boxy tote as four pieces + a closing seam ring (the Step 2 minimum):**

```jsonc
{
  "schema": 3, "kind": "freeform", "name": "Boxy Tote",
  "pieces": [
    { "id": "p_base",  "name": "Base",  "count": 1, "nodes": [{ "x":0,"y":0 },{ "x":300,"y":0 },{ "x":300,"y":120 },{ "x":0,"y":120 }], "layout": { "x": 0, "y": 200 } },
    { "id": "p_front", "name": "Front", "count": 1, "nodes": [{ "x":0,"y":0 },{ "x":300,"y":0 },{ "x":300,"y":250 },{ "x":0,"y":250 }], "layout": { "x": 0, "y": 0 } },
    { "id": "p_back",  "name": "Back",  "count": 1, "nodes": [{ "x":0,"y":0 },{ "x":300,"y":0 },{ "x":300,"y":250 },{ "x":0,"y":250 }], "layout": { "x": 340, "y": 0 } },
    { "id": "p_sideL", "name": "Side L","count": 1, "nodes": [{ "x":0,"y":0 },{ "x":120,"y":0 },{ "x":120,"y":250 },{ "x":0,"y":250 }], "layout": { "x": 680, "y": 0 } },
    { "id": "p_sideR", "name": "Side R","count": 1, "nodes": [{ "x":0,"y":0 },{ "x":120,"y":0 },{ "x":120,"y":250 },{ "x":0,"y":250 }], "layout": { "x": 820, "y": 0 } }
  ],
  "seams": [
    { "id":"s_bf", "a":{"piece":"p_base","edge":0}, "b":{"piece":"p_front","edge":0}, "foldAngle":90 },
    { "id":"s_bb", "a":{"piece":"p_base","edge":2}, "b":{"piece":"p_back","edge":0},  "foldAngle":90 },
    { "id":"s_bl", "a":{"piece":"p_base","edge":3}, "b":{"piece":"p_sideL","edge":0}, "foldAngle":90 },
    { "id":"s_br", "a":{"piece":"p_base","edge":1}, "b":{"piece":"p_sideR","edge":0}, "foldAngle":90 },
    { "id":"s_fl", "a":{"piece":"p_front","edge":3},"b":{"piece":"p_sideL","edge":2}, "foldAngle":90 },
    { "id":"s_fr", "a":{"piece":"p_front","edge":1},"b":{"piece":"p_sideR","edge":2}, "foldAngle":90 },
    { "id":"s_back_l", "a":{"piece":"p_back","edge":1},"b":{"piece":"p_sideL","edge":1} },  // CLOSURE seam: angle solved
    { "id":"s_back_r", "a":{"piece":"p_back","edge":3},"b":{"piece":"p_sideR","edge":1} }   // CLOSURE seam: angle solved
  ]
}
```

The base + four walls form a spanning tree (the `foldAngle:90` seams); the two
`s_back_*` seams close the wall ring — they're the **closure constraints** Step 2's
solver reconciles (§5).

**(b) A bodice front + back, joined at shoulders & sides, with a waist dart:**

```jsonc
{
  "schema": 3, "kind": "freeform", "name": "Simple Bodice",
  "body": { "heightMm": 1650, "bustMm": 920, "waistMm": 740, "hipMm": 980 },
  "pieces": [
    {
      "id": "p_front", "name": "Bodice Front", "count": 1, "seamMm": 12,
      "nodes": [ { "x":0,"y":0 }, { "x":200,"y":0 }, { "x":200,"y":300 }, { "x":0,"y":300 } ],
      "edges": { "2": { "curve": { "type":"quad", "cp":[0.5,0.12] } } },     // gently curved shoulder
      "darts": [ { "id":"d_waist_f", "edge":0, "center":0.5, "width":24, "depth":90, "kind":"wedge" } ],
      "notches": [ { "edge":1, "t":0.5, "type":"single" } ],
      "place3d": { "role":"front" }, "layout": { "x":0, "y":0 }
    },
    {
      "id": "p_back", "name": "Bodice Back", "count": 1, "seamMm": 12,
      "nodes": [ { "x":0,"y":0 }, { "x":200,"y":0 }, { "x":200,"y":300 }, { "x":0,"y":300 } ],
      "edges": { "2": { "curve": { "type":"quad", "cp":[0.5,0.10] } } },
      "notches": [ { "edge":3, "t":0.5, "type":"single" } ],
      "place3d": { "role":"back" }, "layout": { "x":240, "y":0 }
    }
  ],
  "seams": [
    { "id":"s_shoulder", "a":{"piece":"p_front","edge":2}, "b":{"piece":"p_back","edge":2},
      "anchors":[ {"ta":0.0,"tb":1.0}, {"ta":1.0,"tb":0.0} ], "ease":0.0 },     // curved, opposite directions
    { "id":"s_side", "a":{"piece":"p_front","edge":1}, "b":{"piece":"p_back","edge":3},
      "anchors":[ {"ta":0.0,"tb":1.0}, {"ta":0.5,"tb":0.5}, {"ta":1.0,"tb":0.0} ], "ease":0.0 }
    // the waist-dart self-seam is auto-derived from p_front.darts[0] — not authored by hand
  ]
}
```

- **Print** (today's pipeline, unchanged): `pieceGeom` flattens the curved shoulder +
  cuts the dart wedge → `cut` polylines; notches/dart fold-lines → `cut`/`seam` ticks;
  `freeformToDoc` shelf-packs at each `layout`.
- **Step 2** reads `seams`, hinges the pieces, collapses the dart.
- **Step 3** triangulates each flattened piece, resamples each seam between `anchors`
  to a common arc-length sampling (so curved, slightly-unequal shoulders still zip),
  collapses the dart apex, and drapes on the `body` form.

---

## 4. Step 1 — Box preview

### 4.1 Scope

Prove the no-build loader end-to-end with **zero physics**, on the boxy tote, which
already exists and whose 3D shape is fully known from its parameters. Tap "Preview" on
a tote → an orbitable 3D box with the panels textured by their pattern outlines. No
seam graph yet (the box knows it's a box). This validates three.js on the iPad and the
texturing approach Steps 2–3 reuse.

### 4.2 Approach — `docToMesh` + per-face texturing

- A new `app/static/js/preview3d.js` (the page module) sets up `Scene`,
  `PerspectiveCamera`, `WebGLRenderer`, `HemisphereLight`, `OrbitControls`.
- `docToMesh(doc)`: for the boxy tote, read the panel dimensions (front/back/sides/
  base) and place six `PlaneGeometry`/`BufferGeometry` quads into a box, parented in a
  scene graph (the same parent→child structure Step 2 generalizes).
- **Per-face texturing**: render each panel's flattened `cut` outline (+ seam line,
  grainline, label) to a `CanvasTexture` and map it onto that face, so the preview
  *reads as the actual pattern piece*, not a blank box. This canvas-to-texture step is
  reused verbatim by Steps 2–3 (the only difference is *where* the textured panel
  lands).
- Start from the *parameters* for Step 1 (it's the proven path); when the seam graph
  arrives in Step 2, `docToMesh` switches to folding from `seams[]` and Step 1's
  hardcoded box becomes a special case.

### 4.3 Tests, done-criteria, effort

- **Tests** (`tools/preview/verify-box-mesh.mjs`): `docToMesh` produces 6 faces with
  correct dimensions and a closed box bbox; texture-UV mapping is deterministic.
- **Done:** on the iPad, open a saved boxy tote → tap Preview → orbit a correctly-
  proportioned, pattern-textured 3D box; pinch-zoom and rotate are smooth; Home/Draw
  flows unaffected; `ASSET_VER` busts the vendored three.js on deploy.
- **Effort:** ~2–4 focused sessions. The risk here is *loader plumbing*, not geometry.

---

## 5. Step 2 — Seam authoring + rigid fold-up

This is the genuinely hard constructed step, and it's where the seam graph is born.

### 5.1 The "Sew" mode UX (new cross-piece selection model)

The editor's current selection is *within one piece* (drag a node, add a notch). Sewing
needs a **cross-piece edge-pair selection**: tap an edge on piece A, tap an edge on
piece B, and a seam is created. New UI on `/edit` (and/or the preview page):

- A **"Sew" mode toggle** alongside the existing Notch mode. In Sew mode, tapping a
  piece edge highlights it; tapping a second edge (on any piece) creates a `seam`
  with `a`/`b` set to those `EdgeRef`s.
- **Direction & flip**: show the two edges' arrow directions; a one-tap "flip"
  reverses `b` (sets `anchors` to `ta:0↔tb:1`) for seams sewn in opposite directions
  (the common case — adjacent pieces meet head-to-tail).
- **Notch-anchored correspondence**: if both edges already carry notches, offer
  "match notches" to seed `anchors` from them.
- **Per-seam fold angle**: a slider/preset (`90°` for boxes; `null`=solve) writes
  `foldAngle`. Templates seed it (a boxy-tote template sets the four base-wall seams
  to 90°).
- The seam list is editable (rename, delete, re-pick edges), and seams render as
  colored connectors between pieces on the board so the graph is legible.

### 5.2 The fold algorithm (spanning tree + closure constraints)

A bag's seam graph **has cycles** (front→side→back→other-side→front closes a loop),
which is what makes this not a textbook "unfold a net." The structure is the inverse
of polyhedron-net unfolding (a net is a spanning tree of the dual graph); we fold *up*
along a chosen spanning tree and the non-tree seams become **closure constraints**.

1. **Build the hinge graph.** Nodes = pieces, edges = seams. Validate each seam is
   hinge-able: the two paired (flattened) edges have near-equal length (tol ~1–2 mm).
   Unequal ⇒ eased/gathered ⇒ not rigid ⇒ flag and degrade (§5.3) — and that's the
   signal it belongs to Step 3.
2. **Spanning tree + root.** Root = largest-area piece (the tote's base; author can
   pin). **BFS** from the root (shallower trees ⇒ shorter rotation chains ⇒ less
   accumulated error). Tree seams → hinges; the rest → closure constraints. Cycle
   count = `#seams − (#pieces − 1)`.
3. **Forward fold (the tree gives a complete pose).** Lay the root flat. BFS-propagate:
   position each child so its paired edge coincides with the parent's hinge edge
   (rigid 2D placement, mirror if flipped), then rotate the child's whole subtree by
   the dihedral `foldAngle` about the hinge edge. In three.js this is the
   **translate-pivot-onto-the-hinge-edge** transform — build each piece as a
   `THREE.Group` whose local origin sits on its hinge edge; `parentGroup.add(childGroup)`
   so the scene graph *is* the spanning tree and rotating one hinge moves its subtree
   automatically. After this pass every piece has a 3D pose; the closure seams are
   simply not yet sewn shut.
4. **Reconcile closure seams (the cycle problem).** Solve for the tree dihedral angles
   that close the non-tree seams. **Ship the point-pair least-squares form:** for each
   closure seam, residual = the 3D gaps between its two edges' endpoints; minimize
   `Σ‖r‖²` over the tree angles with **Gauss–Newton / Levenberg–Marquardt**. The
   Jacobian is analytic (perturbing one hinge rigidly rotates only its subtree:
   `∂P/∂θ = ω × (P − pivot)`), so no finite differences. Problem sizes are tiny (a
   tote: ~5 pieces, ~8 seams, ~2 cycles, <10 unknowns) — LM converges in a handful of
   iterations at interactive rates in pure JS on the iPad. (The theory-correct
   SO(3)/loop-closure form `∏R = I` is documented as the rigorous fallback; the
   point-pair form degrades more gracefully and its residual is in millimeters, so the
   UI can show "bag closes to within 0.4 mm.")

**Fold-angle sourcing**, in priority: (1) authored/template `foldAngle` (a boxy tote =
four 90° base seams, no solve needed); (2) template defaults; (3) solver-inferred for
`null` seams. Hybrid (recommended): authored angles are the initial guess + soft
anchors; the solver only moves `null` angles and adds a weak regularizer
`+μ Σ(θ−θ_pref)²` so a slack bag picks the nicest of its valid folds.

### 5.3 Where it degrades (never hard-fail)

- **Closes (‖r‖<tol):** render the sewn bag, closure seams solid.
- **Nearly closes:** render the best-fit tree fold; draw unclosed seams as dashed
  "needs easing" lines and show the gap in mm. Still a useful preview.
- **Can't close / non-hingeable seam:** fall back to the **tree-only fold** (a tree is
  *always* foldable), mark the offending seam "soft seam — drape preview (Step 3)."
  The mismatch is information (it's the ease the sewer distributes), not a bug.
- **No seams yet:** lay all pieces flat on the board — i.e. Step 2 with zero folds is
  exactly today's flat layout. Continuity guaranteed.

### 5.4 Modules/files, tests, done, effort

- **New:** `app/static/js/pattern-fold.js` (pure, headless: hinge graph, spanning
  tree, forward fold, LM closure solve — no three.js, returns per-piece 3D transforms);
  `preview3d.js` gains the fold renderer; `editor.js` gains Sew mode; `pattern-geom.js`
  gains `seams[]` normalization + dart self-seam emission.
- **Tests** (`tools/preview/verify-fold.mjs`): a unit cube's net folds to a closed
  cube (closure residual → 0); the worked tote closes within tol; a deliberately
  mismatched panel degrades to tree-only; BFS root choice + cycle count are correct.
  The fold math is fully deterministic and auto-testable.
- **Done:** author seams on a multi-piece bag in Sew mode → tap Preview → watch it fold
  up and close; a non-box bag with `null` angles solves to a closed shape; mismatches
  degrade visibly with a mm gap readout.
- **Effort:** ~5–8 sessions. The Sew-mode UX and the LM solver are the substance; the
  three.js hinge transform is well-trodden.

---

## 6. Step 3 — Cloth drape (the goal)

The destination: sew flat panels into a **draped** 3D garment (and inflated bag),
gravity + collision deciding the shape. This is a separate module set, linked from the
preview page, and developed in two sub-milestones: **3a (inflated bag)** then **3b
(garment on a form)**.

### 6.1 Solver choice & why

**Hand-roll an XPBD mass-spring solver** (`app/static/js/pattern-cloth.js`), CPU,
single-threaded JS, on top of three.js (render only). Use off-the-shelf libs only for
non-physics parts: three.js (render, MIT), `poly2tri` (triangulation w/ Steiner
points, BSD-3) + `earcut` (ISC) fallback, and the already-vendored Maker.js for curve
flattening.

Rejected as the engine:
- **ammo.js / Bullet `btSoftBody`** (zlib): capable and its sewing primitive exists
  (`appendLink` across bodies), but the canonical build is pinned to Bullet 2.8.2 and
  is effectively unmaintained; it's a ~1.5 MB WASM blob; and its soft-body API is
  opaque — the stitch-stability protocol you most need (zero-gravity stitch-up, eased
  stiffness, velocity clamping) has to be bolted on *outside* it anyway. You'd inherit
  the weight without the hard part.
- **Rapier** (Apache-2.0): no cloth/soft-body, none planned (2026 goals = robotics +
  GPU rigid bodies). Wrong tool.
- **three-simplecloth** (MIT, WebGPU/TSL): real and current, but built to drape a
  *region of one skinned mesh* — it has **no mechanism to sew two separate pieces**,
  which is the entire problem. Mine it later for the TSL-compute path (3c), not now.

Why XPBD wins: it's exactly what the modern garment-drape research stack uses
(GarmentCodeData represents a garment as panels + an edge-pair stitch list and drapes
with PBD/XPBD); it gives **total control** of the stitch-up stability protocol
(XPBD `compliance` is a clean continuous stiffness knob), trivial pinning (inverse
mass = 0), a distance constraint that doubles as the sewing spring, a small auditable
dependency-free codebase living in `pattern-*.js` like `pattern-geom.js`, and a clean
later upgrade to TSL compute.

### 6.2 Panel triangulation

A boundary-only polygon can't bend (no interior DOF). Triangulate each piece's
flattened `cut` polyline into a sim mesh with **interior Steiner vertices**:

1. Resample the boundary to ~uniform edge length `h` (target node spacing).
2. Generate interior Steiner points on a grid at spacing `h`, keep those inside
   (point-in-polygon — `pointInPoly` exists today but in `editor.js` (DOM-coupled UI);
   lift it into the pure `pattern-geom.js`/`pattern-mesh.js` layer so the triangulation
   stays headless-testable, like the other pure geometry helpers).
3. Constrained-Delaunay triangulate boundary + interior with **poly2tri**
   (`SweepContext` accepts contour + holes + interior points; dedupe within epsilon,
   simple polygons only — ours are). `earcut` is the fallback for degenerate cases
   (boundary-only, manual Steiner insertion).

Each triangle edge → a **distance constraint** (stretch spring); each interior shared
edge → a **bending constraint** (dihedral, or the cheaper opposite-vertex distance
approximation). Target **~1–4k nodes for the whole bag/garment** (spacing `h` ≈
15–25 mm), exposed as a "Preview detail: Draft / Standard / Fine" slider.

### 6.3 Seam stitching incl. unequal-length / gathers via notches

Our `seams[]` already match the research representation. Along each seam, sample
`N = max(nodesA, nodesB)` correspondence pairs by arc-length **within each
notch-bounded sub-span** (`anchors`). For each pair create a **zero-rest-length
distance constraint** (a sewing spring) during stitch-up; after the seam settles,
**weld** each pair into one shared node (average position, sum masses, rewire triangle
fans) to kill residual jitter and halve seam constraint count.

**Unequal lengths / ease / gathers fall out for free:** because correspondence is by
normalized arc-length *per notch-span*, a 200 mm edge sewn to a 160 mm edge gathers
the longer edge into folds between the same anchors. `ease` is the soft version;
`gather.region`/`ratio` scopes/strengthens it. No special code.

### 6.4 Inflation (bags) vs gravity (garments)

- **Bags — pressure/volume.** Sew shut, then *inflate*: add a soft volume constraint
  (enclosed volume via the divergence theorem over the closed mesh) pushing toward a
  target, or a per-face outward-normal "puffiness" force. **No body, no heavy
  self-collision** — this is the 3a deliverable.
- **Garments — gravity.** Disable pressure, enable gravity (scaled to mm units). Each
  triangle's rest shape = the 2D pattern (flat = undeformed) — the research convention.
  Fabric stretch/bend stiffness + weight become "cotton / denim / silk" presets.

### 6.5 Pinning & self-collision

- **Pinning** (straps, shoulders, waistbands): inverse mass = 0 — the universal PBD
  pin. Mark in the doc (`place3d`/`placements`/a `pins[]`). Straps pin where they
  attach; a garment pins at shoulders/waist during warmup, then releases.
- **Self-collision** (the expensive part): a **uniform spatial hash** at cell ≈ `h`,
  node-vs-node repulsion if closer than fabric thickness. Enable **only in final
  settle passes**, and only for garments. Off during stitch-up (most expensive, least
  necessary then).

### 6.6 The stability protocol (sewing springs explode — make-or-break)

Naive full-stiffness zero-length seam springs on flat, far-apart panels → NaN. The
protocol, in order:

- **A. Pre-placement (no springs yet).** Rigidly place each panel near its final
  neighborhood so seam endpoints start *close*. **This is where Step 2 pays off:** the
  rigid fold-up (or, for garments, a cylindrical/`place3d`-hinted wrap around the body
  bands) is the warm start. Good placement is 80% of stability.
- **B. Zero-gravity stitch-up.** Gravity + pressure OFF; only structural + seam
  springs, seam stiffness **eased in** over ~30–60 substeps (ramp XPBD `compliance`
  soft→stiff). Panels float together; seams close stably.
- **C. Small-step substeps + velocity clamping.** Many substeps, 1 iteration each
  (~8–20 during stitch-up); clamp per-substep node moves to ≈ `0.5·h` — the single
  most important explosion guard.
- **D. Hand off to drape.** Seams within tol (< ~1 mm) → weld pairs → enable gravity
  (garment) or pressure (bag), enable self-collision (garment).
- **E. Settle then freeze.** Run until kinetic energy < threshold, freeze the mesh,
  cache it. Show a brief "settling…" indicator (a second or two), then a crisp result.

### 6.7 The parametric body / dress form (3b)

**Build the collider as a procedural parametric "dress form"** — a limbless torso
**lofted** at runtime in three.js from a hand-authored 2D silhouette profile through a
stack of **elliptical** cross-section rings whose bust/waist/hip circumferences are
driven by the doc's `body` measurements. The "asset" is ~200 lines of JS + a tiny
profile table (~3–5 KB), no binary, no license entanglement — and a dress form *has*
no arms/legs precisely because limbs get in the way of draping. (`LatheGeometry`
revolves a profile but only into circular sections — bodies are elliptical, wider than
deep — so generate a `BufferGeometry` of lofted elliptical rings directly; three.js
has no built-in loft.)

Measurements → geometry: height scales the Y extent; each of bust/waist/hip solves the
ring's `(a,b)` semi-axes for the target circumference at a fixed depth:width aspect
(Ramanujan's perimeter approximation), Catmull-Rom interpolated between bands. "Change
waist to 76" re-lofts in <1 ms — the control parameters *are* her measurements, the
big win over SMPL/MakeHuman.

**Collision is analytic, not a mesh/SDF.** Following GarmentCodeData (which uses a
custom body + a "push each cloth vertex found inside the body to the nearest surface
point" constraint, not SDF/trimesh colliders): for a cloth vertex at height `y`, look
up the ring `(a,b)` (1D interpolation), test `(x/a)² + (z/b)² < 1`; if inside, project
to the ellipse boundary + a few-mm skin offset with a one-sided XPBD constraint. O(1),
no BVH, no `btGImpactMesh`, no baked SDF. (Rejected heavier options, briefly: **SMPL-X**
— non-commercial model license + ML-fitting overkill; **MakeHuman/MPFB** — assets are
CC0 and it's the documented escape hatch if sleeves/collars later need real shoulders,
but it's a Blender-side bake producing a heavier asset with *worse* measurement
mapping; **avatar libs** — cosmetic shape control, brand strings.)

### 6.8 Garment specifics (curves / ease / darts) & perf budget

Curves (necklines/armholes), ease, and darts are exactly the schema-3 additions of
§3.3; they flatten/triangulate/stitch through the same pipeline. Initial garment
placement walks the seam graph outward from the top (shoulder band height), wrapping
each panel around the form's ellipse at its band (front panel front half, back panel
back half) so cloth starts *outside* the body; pin landmark vertices during warmup,
release after N frames, settle.

**Perf budget (iPad, honest):** ~1–4k nodes whole-garment is the safe band for a
single-threaded JS XPBD solver on an M-class iPad — the drape is a **settle-once**
operation (a second or two to converge), not a per-frame game loop. The published
WebGPU "640k nodes @ 60 fps" figure is a desktop RTX result and does **not** transfer
to iPad; treat 1–4k as the engineering estimate to confirm with a prototype.
Multi-threaded WASM is effectively blocked on Safari (SharedArrayBuffer needs COOP/COEP
and Safari lacks `COEP: credentialless`), so plan single-threaded; WebGPU compute (TSL)
is a later optional accelerator (3c) only if node counts must rise — render can use
WebGPU today (Safari 26 / iPadOS 26 ships it), but the solver starts on the CPU.

### 6.9 Modules/files, tests, done, effort

- **New:** `app/static/js/pattern-cloth.js` (XPBD core), `pattern-mesh.js`
  (triangulation), `body-form.js` (loft + analytic collider), `app/static/js/vendor/
  poly2tri.js`; `preview3d.js` gains the drape view + cache load/save;
  `app/templates/preview.html` gets the detail/fabric/measurement controls.
- **Tests:** `tools/preview/verify-mesh.mjs` (triangulation: node count vs `h`, all
  triangles inside, no duplicate points), `tools/preview/verify-seam-correspondence.mjs`
  (arc-length pairing across unequal edges; notch anchors land), `tools/preview/
  verify-body-form.mjs` (ring circumferences match measurements; `insideForm` true/
  false on known points). **The drape *look* and the stitch-up not exploding on real
  patterns are NOT auto-testable** — verified by hand (§7).
- **Done (3a):** tap Preview on a boxy tote → sewn, inflated, orbitable bag, cached so
  reopen is instant. **Done (3b):** sew a simple flat garment (tank/skirt) → watch it
  drape on a measurement-fit form; fabric presets visibly change the hang.
- **Effort (honest):** 3a ~6–10 sessions (proves sewing + stability + cache end-to-end,
  the riskiest plumbing). 3b ~10–20 sessions and the most uncertain in the whole plan —
  the stability protocol on *real, slightly-inconsistent* hand-drawn patterns is where
  the hard patches live. This is the part she's signing up to work through.

---

## 7. Testing & verification strategy

**Auto-testable (headless `.mjs` in `tools/`, like `verify-editor-geom.mjs`)** — the
deterministic geometry, run in Node by eval'ing the pure modules (`pattern-geom.js`,
`pattern-fold.js`, `pattern-mesh.js`, `body-form.js` — all kept DOM-free and
dependency-light for exactly this reason):

- Schema-3 normalization + backward-compat (legacy notch → `(edge,t)`; schema-1/2 load).
- Edge-identity stability (a seam survives a radius/curve/node-move change).
- Fold: net→closed-solid closure residual → 0; tote closes within tol; mismatch
  degrades to tree-only; BFS root + cycle count.
- Triangulation: node count vs `h`, all triangles inside, no dup points.
- Seam correspondence: arc-length pairing across unequal edges; notch anchors.
- Body form: ring circumferences = measurements; `insideForm` on known points.
- Cache round-trip: `preview3d` invalidation on geometry change.

**Hand-verified only (no honest automated oracle)** — and how:

- **Sew-mode drag/tap UX on the iPad** (the SVG interaction, like today's editor drag
  UX which is also manually verified): build it and draw on the actual device.
- **The drape *look*** — does the dress hang believably? Eyeball it against the real
  sewn garment; this is a preview, not a digital twin.
- **Stitch-up stability on real patterns** — the make-or-break. Test on her actual
  saved patterns (a tote, a dress attempt), watch for explosions/NaN, tune the §6.6
  protocol. Keep a small corpus of real docs as regression fixtures even though the
  pass/fail is visual.

---

## 8. Risks, caveats & mitigations

- **iPad perf / UX.** Cloth on a tablet single core is the biggest unknown. *Mitigate:*
  settle-once (not per-frame), the 1–4k-node budget + detail slider, cache the result
  so reopen is free, prototype the budget early in 3a before committing 3b.
- **Sim stability (sewing springs explode).** The classic failure. *Mitigate:* the full
  §6.6 protocol (Step-2 warm-start placement, zero-gravity eased stitch-up, small-step
  + velocity clamping), and **always degrade gracefully** (Step 2 falls back to
  tree-only; Step 3 can fall back to Step 2's rigid fold if the drape won't settle).
  The feature must never hard-fail to a blank screen.
- **Fidelity ceiling.** Rigid fold ≠ draped ≠ photoreal. *Mitigate:* set expectations
  in copy — "a shape preview, not a fabric simulator." Rigid panels under-represent
  curved/darted faces; the drape under-represents fine fabric behavior. That's
  acceptable for "will this look right before I cut."
- **Maintenance / licensing of vendored libs.** three.js (MIT) is ESM-only and evolves;
  poly2tri (BSD-3)/earcut (ISC) are stable. *Mitigate:* pin three + addons as a matched
  set, document the update procedure in `vendor/three/README`, avoid ammo.js (stale)
  entirely. No GPL/non-commercial assets enter the shipped app (dress form is our own
  code; MPFB-CC0 is only a documented escape hatch).
- **Scope creep (the garment swamp).** Darts, gathers, curves, body fitting can each
  balloon. *Mitigate:* the schema is additive and each feature lowers to existing line-
  kinds, so partial support is always shippable; gate each at a decision point (§9);
  keep Step 3 a separate module that can be turned off without touching print/edit.
- **The print spine.** *Mitigate (absolute):* the preview is read-only of the document
  and never calls a print endpoint; `pattern-pdf.js`/`printing.py`/the tiler/the
  calibration gate are not edited. This is the one line that does not move.

---

## 9. Milestones & sequencing

Ordered, checkable, with rough effort and the decision gate between each. (Effort =
focused sessions; estimates, not commitments — 3b especially.)

- [x] **M0 — Loader spike (~1–2 sessions). DONE 2026-06-21.** Vendored three r184
  (`three.module.js` + `three.core.js` + OrbitControls) + a `/preview/{id}` route +
  `preview.html` + `preview.js`, rendering a hardcoded orbitable cube. **Gate cleared:**
  import map + touch orbit confirmed on her actual iPad; print spine untouched.
- [x] **M1 — Step 1 box preview (~2–4). DONE 2026-06-21.** `docToMesh` + per-face pattern
  texturing for the boxy tote; `verify-box-mesh.mjs` (18 checks). Gate cleared on her iPad —
  proportioned, pattern-textured box; flat leather straps (arc length = strap length); a
  studio/atelier look + "finished measurements" spec plate; inches/cm units. (`preview3d.js`
  imports only `three` so the test runs in Node via `tools/preview/three-resolver.mjs`.)
- [x] **M2 — Seam graph + Sew mode (~3–5). DONE 2026-06-21.** Schema-3 top-level `seams[]`
  (`EdgeRef {piece:<id>, edge:i}`, stable/unique piece ids, `G.normalizeSeams`, edge-identity
  stable under node-move/radius — `tools/tiling/verify-seams.mjs`), Sew-mode selection UX on
  `/edit` (tap edge↔edge → seam; connector + seam list; per-seam fold-angle preset), round-trips
  through save + undo/redo. Gate cleared on her iPad. **Deferred to M3+:** notch `{edge,t,type}`
  upgrade + anchors UI, dart authoring/self-seams, seam flip (the fold makes direction visible).
- [x] **M3 — Step 2 rigid fold-up. DONE 2026-06-21.** `pattern-fold.js` (pure/headless
  `window.PatternFold.foldDoc`: spanning-forest BFS + forward kinematics + LM closure solve;
  **per-seam direction is searched** for the globally-consistent assignment that closes — a box
  and a tube need opposite head-to-tail/head-to-head conventions; degrade-never-blank ladder).
  `preview3d.js` freeform path: `ShapeGeometry` faces placed by `{pos,quat}`, `pieceFaceTexture`,
  dashed gap seams, **outward-normal UV flip** (so inward-facing panels' pattern text isn't
  mirror-reversed). Routing + fold readout + **Floor-piece override** (auto-detect base by
  hinge-degree, persisted additive `foldRoot`); Sew-mode **flip-direction toggle**. Tests
  `tools/preview/verify-fold.mjs` (33) + `verify-fold-mesh.mjs` (9). Gate cleared on her iPad.
  **Refinements vs this doc:** root = max hinge-degree, not largest area (a tall tote's largest
  panel is a wall, which would lay the bag on its face); the worked tote's cycle count is **4**,
  not the "~2" §5.2 implies; and **§3.6(a)'s tote JSON has an edge-index slip** — it pairs front's
  250 mm vertical edge to a side's 120 mm top edge (non-hingeable); `verify-fold.mjs` uses the
  geometrically-consistent vertical pairings.
  - [x] **STRAP integration DONE (2026-06-21).** Strap pieces are excluded from the rigid fold
    (a detect → split-before-classify → render-separately pass, so a both-ends-sewn band can't
    degrade the bag); `foldDoc` returns additive `straps[]` and `preview3d.addStraps` draws an
    arched leather handle per strap. A **grab** handle (both ends on one edge) is a planar
    rainbow; a **span** (ends on two edges) sweeps its width along the bag edges (`widthDir`) so
    it isn't twisted; count×2 grab auto-mirrors to the opposite face and count×2 span renders a
    parallel pair. Additive per-piece `role` + editor Type toggle. *Deferred: plain-leather bands
    (no pattern texture).*
- [ ] **M4 — Step 3a inflated bag (~6–10).** `pattern-mesh.js` (poly2tri), `pattern-
  cloth.js` (XPBD: distance/bend/seam/pressure), the §6.6 stability protocol,
  `preview3d` cache; mesh/correspondence tests. **Gate:** a sewn, inflated, orbitable,
  cached bag that doesn't explode on her real tote.
  - [x] **Prep layer done (2026-06-21, headless only — no visible change yet).** Vendored
    `poly2tri.js`; `pattern-mesh.js` triangulates a piece into a sim mesh (boundary resampled
    to ~h with authored-edge+t tags, interior Steiner grid, CDT, distance+bend constraints —
    `verify-mesh.mjs`, 15) and pairs seam nodes by arc-length honoring the fold's head-to-
    tail/head-to-head direction (`seamPairs` — `verify-seam-correspondence.mjs`, 16).
  - [ ] **Next: `pattern-cloth.js`** — the XPBD core consuming mesh + seamPairs + the rigid
    fold as the warm start: §6.6 stitch-up (zero-gravity, eased seam stiffness, small substeps
    + velocity clamp), weld, inflate (volume/pressure), settle; then the `preview3d` drape view
    + `preview.html` detail slider + the `preview3d` settled cache. Ends in her hands-on gate.
    **Full starting orders: `HANDOFF-M4-cloth.md`.**
- [ ] **M5 — Step 3b garment on a form (~10–20).** `body-form.js` (loft + analytic
  ellipse collider) driven by `body` measurements; gravity drape, pinning + timed
  release, spatial-hash self-collision, fabric presets, curves/ease/darts in the drape.
  **Gate:** a simple flat garment drapes believably on a measurement-fit form.
- [ ] **M6 (optional, deferred) — TSL-compute acceleration / MPFB body.** Only if the
  CPU budget or dress-form fidelity proves limiting in real use.

The gates are real stop points: each milestone ships something useful, and 3b is not
begun until the seam graph and rigid fold (M2/M3) are proven, because they ARE the
warm start that makes the drape tractable.

---

## 10. Open questions for the owner

1. **Dress-form fidelity — RESOLVED (2026-06-21): sleeveless torso is enough for now.**
   The smooth limbless lofted torso (bust/waist/hip, §6.7) is the M5 target. She's only
   made skirts + tank-style dresses so far; no sleeves/collars seen yet. Sleeves stay an
   **additive M6 escape hatch** (CC0 MPFB body + a collider swap) — and crucially the
   on-ramp doesn't get thrown away to add them: the seam graph, triangulation, XPBD
   solver, stitching, fabric presets, and the whole schema-3 data model carry forward
   unchanged; only the *collider* gains arms. So building sleeveless-first costs nothing
   later. (Still open: the exact trigger to start M6 — confirm when a real sleeved
   attempt appears.)
2. **Garment scope — RESOLVED (2026-06-21): skirts + tank-style (sleeveless) dresses
   first.** This is the easy, high-value end of §3.3: minimal curves, few/no darts, no
   sleeve-cap easing. 3b can ship with light curve/dart support and grow it; the full
   curve/dart/gather machinery is specced but not all needed on day one.
3. **Where the settled-drape cache lives.** In-document `preview3d` (recommended — rides
   CRUD + the nightly backup, syncs across her devices, but inflates the doc by tens of
   KB) vs an IndexedDB-only client cache (smaller docs, but device-locked + unbacked,
   re-drapes on a new device). Recommendation stands at in-document; confirm she's fine
   with the doc size.
4. **How much authoring vs preview.** Should Sew mode also let her *define* darts/
   gathers/curves in the editor (full authoring), or is the first pass "preview what the
   seam graph implies" with darts/curves added later? This sets the M2 UI scope.
5. **Measurements source.** Enter bust/waist/hip per-pattern (in `body`) or once as a
   shared profile (a new Setting) reused across patterns? A shared profile is friendlier
   but adds a Settings surface and a "whose body" question if patterns are gifts.
6. **Fidelity expectations.** Is "a believable shape preview to sanity-check before
   cutting" the agreed bar (it is what this plan delivers), explicitly *not* a
   photoreal digital twin? Worth confirming so 3b doesn't get chased toward render
   quality it isn't scoped for.
