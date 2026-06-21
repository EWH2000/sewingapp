# Handoff — the freeform pattern editor

> For the next session. Start in `~/sewingapp/`. Read `CLAUDE.md` (app guide),
> `DESIGN.md` (architecture + locked decisions), and `PRINTING.md` (print design)
> first — then this. The app is live at `command.home.arpa/sewing/` (container
> `sewingapp`, port 8006). This document is the spec for building the **freeform
> editor** — the "draw your own" layer (DESIGN.md build-step 5, remainder).

## What this is
Today the app produces patterns from **parametric templates** (boxy tote, rectangle).
The freeform editor adds **direct manipulation**: drag points, add/move/delete
vertices, round corners, set seam allowance, add pockets/notches, name pieces — i.e.
*draw your own* pattern. It is the third of the three layers in `DESIGN.md`:
- template = a function that *produces* a document  ✅ done
- **editor = *edits* a document  ← this handoff**
- printer = *consumes* a document  ✅ done + physically proven

## The leverage: the print path is DONE
The single most important fact: **the editor only has to produce a valid pattern
document. Printing is already solved and physically proven (1:1, single-page and
tiled).** `makeTiledPdf(document)` in `app/static/js/pattern-pdf.js` consumes the
document and emits the tiled, registration-marked, 1:1 PDF that the server relays to
the printer over IPP. **Do not touch the tiler, the IPP path (`app/printing.py`), or
the registration/assertion code.** Build the editor *on top of* the existing
document model and call the existing generator to print/preview.

## The shared document model (the spine — match it exactly)
This is what `makeTiledPdf(pattern)` reads (see `pattern-pdf.js`, and
`rectanglePattern` / `boxyTotePattern` as worked examples):

```js
pattern = {
  name: string,
  kind: "rectangle" | "box" | "freeform",
  widthMm, heightMm,                 // bounding box of the whole layout, in mm
  paths: [                           // every line drawn, clipped per-tile
    { kind: "cut" | "fold" | "seam" | "grain",   // → STYLE table (line weight/dash)
      points: [[x, y], ...] }        // polyline in REAL MM, origin BOTTOM-LEFT, y-up
  ],
  labels: [                          // text drawn on the tile containing its anchor
    { xMm, yMm, size, lines: ["…","…"] } ],   // (informational; not bounds-asserted)
  params: { … }                      // template params (for re-gen); freeform stores its geometry
}
```
Coordinate system: **millimetres, bottom-left origin, y-up** (matches PDF/tiler).
The SVG canvas is top-left/y-down — convert consistently (flip y) at the boundary.
`points` are straight-segment polylines today; the tiler clips line segments
(Liang–Barsky). **Curves must be flattened to polylines before they enter `paths`**
(see below).

## The genuinely hard parts (design around these first)
1. **Curves.** Sewing shapes want rounded corners and curved edges, but the tiler is
   line-based. Decision to make: the editor works in a **richer node representation**
   (vertices that may carry a corner radius or cubic Bézier handles), and a
   `flattenToPolyline()` step renders that to the `points` array the tiler consumes.
   Keep the proven line-based tiler unchanged. (DESIGN.md: "flatten-to-polylines + clip".)
2. **Seam allowance on arbitrary shapes.** For a rectangle it's a trivial inset; for
   a freeform polygon it's **polygon offsetting** — and per DESIGN.md you must **NOT
   hand-roll Bézier/polygon offset** (a cubic's exact offset has no closed form; joins
   self-intersect). Use a library. **Recommendation: Maker.js** (Apache-2.0, UMD —
   vendors as one file, no build step, matching the box's convention): it gives
   rounded corners (`$fillet`), the seam-allowance **`outline`**, AND **DXF/SVG
   export** in one library — covering three backlog items at once. (Clipper2-WASM is
   the alternative for pure offset; Maker.js is the better all-rounder for bags.)
   This is likely the first dependency heavy enough to *eventually* justify a build
   step — but Maker.js itself drops in vendored. Revisit a bundler only if/when
   FreeSewing core is added (DESIGN.md).
3. **Touch UX.** She authors on a phone/iPad. Dragging tiny handles on a phone is
   painful. **Open question for the user (ask early):** is the editor **iPad/desktop-
   first** (bigger canvas, pinch-zoom/pan, ≥24px finger handles), with the phone kept
   for templates + printing? Strong recommendation: yes, iPad-first for *drawing*.
4. **Precision.** Pure freehand isn't enough for sewing. Add **grid snap** (e.g. 5 mm),
   a **live edge-length readout**, and **numeric entry** for the selected point/edge
   (type an exact dimension). This is what makes it trustworthy.
5. **Undo/redo.** The document is small JSON — snapshot it on each edit into a history
   stack. Non-negotiable for an editor.
6. **Single-piece vs multi-piece.** The document already holds multiple pieces. A full
   editor (many pieces, positioning, auto-pack) is a lot. **Recommend phasing:** start
   with **one closed shape**, then add multi-piece.

## Where it slots in (no server/print changes needed)
- **Front-end:** a new editor page/route under the app (e.g. `GET /edit` and
  `GET /edit/{id}`), a `app/templates/edit.html`, and `app/static/js/editor.js` (the
  SVG canvas + interaction). Reuse the house style (`styles.css`), `setStatus`,
  `confirmSheet`, and the `printBytes` / `download` flow from `app.js`.
- **Generate/print/preview:** call the existing `window.PatternPDF.makeTiledPdf(doc)`
  → Download or POST to `/print` (unchanged).
- **Storage:** for `kind:"freeform"`, store the **whole document JSON** in
  `Pattern.params_json` (the model already holds arbitrary JSON — no migration). Then
  in `app.js`, extend `patternFromSaved(p)`: add a `freeform` branch that returns the
  stored document object directly (templates rebuild from params; freeform loads its
  geometry as-is). `POST /patterns` already accepts arbitrary `params`.
- **No changes to:** `printing.py`, the tiler/registration/assertions in
  `pattern-pdf.js`, the quadlet/Caddy/hub wiring.

## Build sequence (each step independently useful)
1. **Render-only canvas.** New `/edit` page: an SVG canvas with pan/zoom that *renders*
   an existing document (load a saved pattern or a template's output) read-only, in
   mm with correct y-flip. Proves the coordinate math + plumbing.
2. **Edit one shape.** Drag/add/delete vertices on a single closed `cut` path; grid
   snap; live edge dimensions + numeric entry; undo/redo. Save (kind `freeform`) and
   Print/Download via `makeTiledPdf` (already works end-to-end).
3. **Corners + seam allowance.** Vendor **Maker.js**; add rounded corners (`$fillet`)
   and compute the cut/stitch lines via `outline`. Flatten curves to `points`.
4. **Pieces + niceties.** Multiple pieces with positioning/auto-pack; notches, pockets,
   grainline/label placement; **SVG/DXF export** (Maker.js, free). 

## Reusable pieces already in the repo
- `app/static/js/pattern-pdf.js` — `makeTiledPdf(doc)` (the consumer), the doc shape
  (see `rectanglePattern`/`boxyTotePattern`), the `STYLE` table, `clipSeg`, the
  per-tile label rendering, and the headless test harness pattern.
- `tools/tiling/verify-browser-gen.mjs` — **how to test browser code headless** (Node
  `window` shim → assert page invariants). Add the editor's `flatten`/offset to it.
- `app/static/js/app.js` — `setStatus`, `confirmSheet`, `download`, `printBytes`,
  `patternFromSaved`, the unit toggle — reuse these patterns.
- `app/main.py` / `app/models.py` — `Pattern.params_json` (store the doc), the
  `/patterns` CRUD, `/print`.
- House style + tokens in `app/static/css/styles.css`.

## Open questions for the user (resolve before building step 2)
1. **iPad/desktop-first editor?** (recommended) — or must drawing work on the phone too?
2. **Maker.js** for curves + seam-allowance offset + DXF (a new vendored dep) — confirm.
3. **Single-shape first** (recommended) vs. jump to multi-piece editing?
4. How much **numeric precision / typed dimensions** vs. freehand does she want?
5. Should freeform patterns also offer **DXF/SVG export** now, or defer (it's nearly
   free with Maker.js)?

## Don't-break checklist
- The 1:1 print contract: `makeTiledPdf` must keep emitting pages that pass its
  self-assertions (612×792, no rotation, CropBox==MediaBox, ink in the ≥13 mm
  keep-out). Run `tools/tiling/verify-browser-gen.mjs` after touching `pattern-pdf.js`.
- The calibration-first gate, SSRF guard, and print lock in `main.py`/`printing.py`.
- House style + BASE_PATH on every emitted URL and `fetch()`.

---
### Suggested first prompt for the new session
> I'm building the **freeform pattern editor** for this app (`~/sewingapp/`). Read
> `HANDOFF-freeform-editor.md`, `CLAUDE.md`, and `DESIGN.md`, then confirm the plan:
> an SVG editor in the browser that edits the shared pattern document and prints via
> the existing (proven) tiler — touching neither the IPP path nor the tiler. Answer
> the handoff's open questions with me (iPad-first? Maker.js? single-shape first?),
> then start with build-step 1 (a render-only pan/zoom canvas over an existing
> document).
