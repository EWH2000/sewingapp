# Sewing — design decisions (server-fit redesign)

A pattern-authoring tool for the household: lets the partner **create her own
sewing patterns** and **print them at home at exact 1:1 scale** (tiled across US
Letter sheets) or save them for later. She currently sews from purchased PDF
patterns; this authors *new* ones. First focus: **bags** (boxy tote), evolving
toward garments without a rewrite.

> The original feasibility brief is `~/sewing-pattern-tool-handoff.md`. It was
> written off-server and assumed this tool would be a *module inside a
> `caddy/dashboard` SPA*. **That premise was wrong for this box** — see below.
> This file supersedes the handoff's *integration/shell* decisions; its
> *engineering* (JSON document model, print spine, library choices) still stands.
>
> The "evolving toward garments" arc has its own forward-looking build spec:
> **`PREVIEW.md`** — the **plan-only** roadmap for a 3D assembled-product preview that
> lands at a soft-body garment cloth-drape. It extends this document's JSON model with a
> seam graph (schema 2→3, additive) and explicitly stays inside the locked decisions
> below (browser-side geometry, no build step, print spine untouched).

## How this box actually works (the corrected premise)
`caddy/dashboard/` is a **single static `index.html`** hub launcher, not an SPA —
there's no shared front-end stack to "slot a module into." The real pattern (used
by pantry/chores/climate/cer/photos/dvds) is: **each app is its own standalone
rootless-podman container (systemd-user quadlet), reverse-proxied by Caddy under a
same-origin sub-path, with one tile in the hub's `services` array.** Apps are
FastAPI + Jinja2 (+ HTMX) + SQLite on a named volume, with a nightly backup timer.
`BASE_PATH` lets one image serve at `/` (dev) and `/sewing/` (behind the proxy).

So this tool is a **sibling app**, not a dashboard module.

## Locked decisions (2026-06-20)
| Decision | Choice | Why |
|---|---|---|
| Shape | Standalone app `~/sewingapp/` (mirrors `cercoachapp/` layout) | Matches the house pattern; nothing else fits |
| Port / path / tile | **:8006** · Caddy `/sewing/` · hub tile **"Sewing"** (`scissors` icon, Home tab) | 8000–8005 taken; 8006 free (verified) |
| Storage | **Server-side SQLite** (FastAPI JSON pattern API) on a named volume + nightly backup timer | Syncs across her phone/iPad/desktop (author anywhere, print where the printer is); rides the backup that covers the SPOF root SSD. IndexedDB-only would be unbacked + device-locked |
| Front-end libs | **Vendored ESM, no build step — for now** | Matches the box's "drop files & refresh" convention; works on the LAN offline. Through the bag phases the deps are `pdf-lib` (+ maybe `Maker.js`), which drop in without bundling. **Trigger to add a build step (Vite/esbuild): when we embed FreeSewing `@freesewing/core`** (garments era) — its dependency graph makes hand-vendoring impractical |
| Root needed? | **None** — high port, rootless, all `systemctl --user` | Unlike most tasks on this box, no root-SSH handoff |

## Visual identity — the atelier theme (evolving, noted 2026-06-21)
Sewing is a **much larger tool** than the other house apps, so (per the owner) it earns its
own distinctive visual identity rather than staying bound to the generic house shell (light
cards + the `#e0653a` orange accent). **Precedent:** the advanced climate app carries its own
BMS-style theme tailored to its domain; Sewing should likewise grow an **atelier /
haberdashery** identity — the materials of her world (paper patterns, fabric, leather
handles, brass hardware, a studio cutting table).

- **First instance — the 3D preview page (`/preview`, built 2026-06-21).** A deliberate
  break from the card-stack into an immersive "showroom": a studio-graphite gradient
  backdrop behind a transparent WebGL canvas, paper-white pattern panels as the hero, a
  **muted saddle-tan leather** strap (calmer cousin of the house orange), a **brass**
  hairline as the signature accent, and a translucent **"Finished measurements" spec plate**
  styled like a pattern envelope (tracked caps, tabular figures). Palette seed (scoped to the
  preview today): paper `#f4efe6`, muted `#a8a39a`, brass `#c8a86b`, leather `#b27c4f`,
  studio sweep `#3a3f48 → #15171b`.
- **The rest is a noted, separate workstream (not yet built).** The Draw/editor and Home
  surfaces can adopt the atelier theme incrementally — promote the preview's palette seed to
  shared design tokens (CSS custom properties) and restyle the editor canvas/rail + home
  builders into the studio aesthetic. **Take liberties where they clearly help now; don't
  derail the 3D-preview milestone ladder (M0–M5) to do a full re-skin.**
- **Non-negotiable regardless of theme:** the print spine, the 1:1 tiler, and the
  calibration gate are untouched — theming is presentation only.

## Architecture spine (unchanged from the handoff)
Store a pattern as ONE structured JSON document: pieces → paths of points + curve
segments, in **real millimeters**, plus metadata (grainline, notches, seam
allowance, labels). The three "features" are thin layers over the same document:
- **template** = a function that *produces* a document — `boxyTote({w,h,d}) → doc`
- **editor** = *edits* a document (drag a corner, round it, add a pocket/notch)
- **printer** = *consumes* a document (tile to Letter PDF)

Render: SVG, internal units mm. Seam allowance: Maker.js `outline` or
flatten-to-polylines + Clipper2 (do NOT hand-roll Bézier offsetting). On this box
the JSON document is also the **server resource** — POST/GET `/patterns`, persisted
to SQLite. (Optional later: IndexedDB mirror for true offline authoring.)

## Print contract (the make-or-break risk)
Browser `window.print()` cannot guarantee scale. So: **generate a real PDF** with
geometry at exact point coordinates (72 pt/in; Letter = 612×792 pt; bottom-left
origin), instruct **"Print at 100% / Actual Size — NOT Fit-to-Page,"** and embed a
**calibration ruler/square** the user measures before printing the rest (tolerance
≈ ±1 mm). Keep critical geometry ≥13 mm from sheet edges (printer hardware
margins). Tiles: ~0.5" overlap, red cut lines, registration marks, A1/B2 labels,
assembly thumbnail.

## Print path (PROVEN — see `PRINTING.md`)
Server prints **directly to the networked printer via driverless IPP** — no CUPS,
no drivers, no root (this box has no print stack at all). HP LaserJet Pro 3001-3008
at **192.168.8.198** accepts `application/pdf` and honors **`print-scaling=none`**
= true 1:1. **Single-page 1:1 physically confirmed 2026-06-20** (measured exact, no
manual margins). Production design (raw IPP in Python stdlib, verified attribute set,
Validate-Job preflight, failure/UX) is in **`PRINTING.md`**. Working references:
`tools/calibration/{ipp-print.mjs,probe-printer.mjs}`.

## Build sequence (each phase independently useful)
1. **Spine + scariest risk first** — calibration PDF → print → measure. ✅ **DONE**
   (`tools/calibration/`; 1:1 confirmed via download AND direct server IPP).
1b. **Tiled multi-page PDF generator** — the real product. ✅ **DONE + 2×2 physically
   proven** (`tools/tiling/`; scale true across seams, triangles register, 50mm/sheet
   true, diagonals continuous). Spec in `tools/tiling/SPEC.md`. Ported into the app's
   browser generator (`app/static/js/pattern-pdf.js`).
2. **One template** — parametric boxy-tote generator → document → print. Complete loop.
3. **Freeform editor** over the same document: drag points, round corners, notches, seam allowance.
4. **App shell** — house container (Containerfile + quadlet + Caddy `/sewing/` + hub
   tile + nightly backup), server SQLite persistence (Pattern + Setting), the
   `POST /print` direct-IPP feature (`PRINTING.md`), browser pdf-lib generation,
   calibration-first gate, Settings page. ✅ **DONE + verified end-to-end 2026-06-20.**
   Current authoring surface = a quick rectangle template.
5. **Templates + editor** — boxy-tote parametric template ✅ **DONE 2026-06-20**
   (`boxyTotePattern` in `app/static/js/pattern-pdf.js`: front/back, sides, base,
   straps — each with seam allowance, stitch line, grainline, label; shelf-packed
   + tiled; headless-verified).
6. **Freeform editor, steps 1–2** ✅ **DONE 2026-06-20** — `/edit` SVG canvas (Draw
   tab) edits one closed polygon (drag/add/delete points, grid snap, live edge
   lengths, numeric entry, undo/redo, pinch/wheel zoom + pan); saves the whole doc
   as `kind:"freeform"` in `params_json` and prints/downloads 1:1 via the unchanged
   tiler. Pure geometry in `app/static/js/pattern-geom.js` (`window.PatternGeom`,
   headless-tested by `tools/tiling/verify-editor-geom.mjs`); UI in `editor.js`.
7. **Multi-piece freeform + step 3 (corners + seam allowance)** ✅ **DONE 2026-06-20** —
   a freeform doc is a list of **pieces** (auto-packed into the tiled layout); open a
   saved tote as editable pieces. **Maker.js** (vendored 0.10.3 browser bundle, loaded
   only on `/edit`) does per-piece **rounded corners** (`chain.fillet`) and **seam
   allowance** (`model.outline` inset), flattened to polylines (`chain.toKeyPoints`) so
   the line-only tiler is untouched; `G.pieceGeom` falls back to straight cut lines when
   Maker.js is absent.
8. **Notches + pocket-placement guides** ✅ **DONE 2026-06-20** — per piece, notch ticks
   (a point re-projected to the nearest edge; Notch mode to add/remove) and dashed
   placement-guide rectangles with a label (e.g. where a pocket attaches: add / drag /
   numeric size / label). Both reuse existing tiler line-kinds (`G.pieceExtras`), so the
   tiler is untouched.
9. **Whole-bag overview + click-to-edit (board layout)** ✅ **DONE 2026-06-20** — the canvas
   shows every piece at once on a shared board (`piece.layout {x,y}`); tap a piece to select +
   zoom in, "Show all" to zoom out, drag a piece to arrange, "Auto-arrange" to pack. WYSIWYG:
   `freeformToDoc` places pieces by their `layout` (packs missing ones via `G.packLayouts`) and
   normalizes the board — the arrangement is what prints. **Next:** SVG/DXF export
   (`makerjs.exporter`); per-corner radius; overlap warning; true pocket↔panel linking.

## Reusable building blocks (licenses verified in the handoff)
FreeSewing `@freesewing/core` (MIT) · Maker.js (Apache-2.0) · pdf-lib (MIT) ·
jsPDF + svg2pdf.js (MIT) · Clipper2 JS/WASM (Boost) · paperjs-offset (MIT) ·
Dexie.js (Apache-2.0, only if an offline mirror is added later).
