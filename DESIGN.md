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
   + tiled; headless-verified). **Next:** the freeform editor over the shared
   document; more templates; SVG/DXF export.

## Reusable building blocks (licenses verified in the handoff)
FreeSewing `@freesewing/core` (MIT) · Maker.js (Apache-2.0) · pdf-lib (MIT) ·
jsPDF + svg2pdf.js (MIT) · Clipper2 JS/WASM (Boost) · paperjs-offset (MIT) ·
Dexie.js (Apache-2.0, only if an offline mirror is added later).
