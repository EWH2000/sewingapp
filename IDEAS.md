# Ideas / backlog

Not commitments — a parking lot. See `DESIGN.md` for the locked architecture.

## Next up
- **Interactive garment-authoring UI** (the active next step — see
  `HANDOFF-editor-authoring-ui.md`): the visual tools on `/edit` to draw curves
  (necklines/armholes), place darts, set notch type, and enter body measurements.
  The data model + print lowering already exist; this is additive UI. (The freeform
  editor itself — draw/drag points, round corners, pockets/notches/seams — is done.)

## Templates
- More bag templates: drawstring bag, zip pouch, boxed-corner tote (one-piece body),
  flat tote (no depth), lined vs unlined variants.
- Garment-era: reuse FreeSewing `@freesewing/core` for parametric drafting (the
  point at which a build step / bundler becomes worth it — see DESIGN.md).
- Notches, darts, foldlines, pleats as first-class document features.

## Print / output
- **Projector mode** — output for a sewing projector (Pattern Projector / PDF
  Stitcher reference impls) instead of paper tiling.
- **SVG / DXF export** (Maker.js gives DXF) → opens the door to Cricut/Silhouette.
- A4 support (the printer + tiler already handle media; expose a page-size choice).
- Smarter piece packing (rotate pieces, nest) to cut sheet count.

## App / UX
- Seam-allowance toggle per piece; show/hide stitch line.
- Fabric/yardage estimate from the layout.
- Per-pattern notes + a photo of the finished item.
- Offline cache (PWA + IndexedDB mirror of the server store) for authoring with the
  server/LAN down — deferred; server-SQLite is the source of truth.
