# Multi-page tiled US-Letter PDF generator (`tools/tiling/make-tiled-pdf.mjs`, pdf-lib, ESM, Node), feeding the SAME ipp-print path. This is DESIGN.md build-sequence phase 1's missing half; the multi-page case is currently UNTESTED, so this artifact must be provable by assertion + a physical 2x2 proof.

INPUT: a pattern as polylines/paths in real millimeters (the DESIGN.md JSON document model: pieces -> points + curve segments in mm, plus cut/fold/grainline/notch/label metadata). For the first build, accept a hardcoded test shape (e.g. a 700mm x 500mm rectangle with an inner cut outline) so the tiling math is verified before the template engine exists.

UNITS & PAGE: IN=72; MM=72/25.4 (~2.83465); every page MediaBox EXACTLY [0,0,612,792]pt (Letter portrait), /Rotate 0, no CropBox (or CropBox identical to MediaBox), MediaBox origin (0,0). NEVER rotate a page — rotate content if ever needed. Place content by translating the drawing, never by cropping a larger page.

KEEP-OUT: SAFE = 13mm from all four sheet edges (clears the probed 4.23mm hardware unprintable margin with margin to spare). All registration marks, labels, and the assembly map live inside SAFE. Cut lines may run to the tile's printable-content rectangle but never into the unprintable border.

TILING MATH:
- Printable content window per sheet = 612 - 2*SAFE wide x 792 - 2*SAFE tall (in pt).
- OVERLAP = 0.5in (36pt) shared band between adjacent tiles, so tile step = window - overlap. Columns = ceil((patternWidthPt - overlap) / (window_w - overlap)); rows likewise for height. The overlap region carries the registration marks so abutting sheets are aligned by eye/trim, NOT butt-joined (sheet feed tolerance is <=1mm/sheet — overlap absorbs it).
- Map global pattern coordinates -> per-tile local coords: for tile (r,c), tile_origin_x = c*(window_w - overlap), tile_origin_y = r*(window_h - overlap) (in the global frame, mm or pt consistently). Draw only the clipped portion of each path that falls within that tile's content window + overlap, translated so the tile's bottom-left content corner sits at (SAFE, SAFE) on the sheet. Use pdf-lib clipping or pre-clip polylines to the tile rect (Sutherland-Hodgman); do NOT rely on printer clipping.
- PAD partial edge tiles to a FULL Letter page (never emit a short page) — the page is always 612x792; only the drawn content stops early. This preserves the per-page MediaBox invariant the preflight asserts.

MARKS PER TILE (inside SAFE):
- Registration crosshairs at the four corners of the content/overlap window: a '+' (e.g. 8mm arms, 0.5pt black) at each shared-band corner so overlapped sheets align cross-on-cross. Add small solid right-triangle 'arrowheads' pointing along each overlap edge toward the neighboring tile, so orientation is unambiguous when assembling.
- A continuous SOLID-BLACK trim/overlap-edge line along each interior (overlapped) edge with a distinct DASH pattern, labeled e.g. 'overlap — trim & match to B2'. Do NOT use color to carry the trim line meaning.
- CUT LINES: render the load-bearing cut line as SOLID BLACK with a distinct long-dash pattern (NOT red) — a mono laser halftones red to mid-gray, the first thing to drop out as toner depletes; red is for redundant labels only. Fold lines = black dash-dot; grainline = black arrow; seam-allowance lines may use a lighter weight but stay black.

LABELS:
- Each tile bears a big row-col label A1/B2-style (rows = letters A,B,C…; cols = numbers 1,2,3…) in a corner inside SAFE, large enough to read at arm's length (e.g. 24pt bold). Also print 'Tile A1 of 3x4 (page 1/12)', the pattern name, and the print date in a footer inside SAFE.
- Each overlap edge names its neighbor ('match to A2', 'match to B1') so assembly is self-documenting.

ASSEMBLY MAP: page 1 (or a dedicated final page) carries a small thumbnail GRID of the full layout (rows x cols), each cell labeled A1/A2/… with the current tile (if per-tile) shaded, plus a 1-line legend (cut = long-dash black, fold = dash-dot, overlap = trim here). Include total page count and finished pattern dimensions in mm and inches.

CALIBRATION ON SHEET: embed a small 50mm reference square (or the 6-inch ruler) on AT LEAST the first tile inside SAFE, so a physical scale check survives into the real product and a human measurement remains the final gate (never trust job-state alone).

OUTPUT & HAND-OFF: write a single multi-page application/pdf (pdf-lib emits ~1.7, within the printer's pdf-versions-supported). Page order = row-major (A1,A2,…,B1,…) matching the assembly map; page-ranges stays absent so all pages print 1:1 via the existing ipp-print path with print-scaling=none + number-up=1.

MANDATORY SELF-ASSERTIONS (fail the build, refuse to print): after generation, reload the PDF and assert for EVERY page getSize()=={612,792}, getRotation().angle===0, mediaBox.{x,y}===0, cropBox deep-equals mediaBox. Assert overlap band width == 36pt on shared edges. Assert no drawn geometry crosses into the <13mm border.

PROOF GATE before claiming the multi-page case: generate a real >=2x2 tiled PDF, run Validate-Job on the multi-page document, print it at Actual Size, physically assemble a 2x2 block and verify (a) a span CROSSING a tile seam measures true to +-1mm, (b) crosshairs register cross-on-cross across the overlap, (c) the 50mm square measures 50mm on a non-first tile too. Single-page success does NOT generalize — this proof is required.
