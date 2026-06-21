# tools/ — proven reference generators (de-risk artifacts)

These standalone Node scripts are where the **1:1 print scale** and the **tiling
geometry** were physically proven on the real printer before any UI existed. The
app's in-browser generator (`app/static/js/pattern-pdf.js`) is a port of them — keep
these as the **canonical geometry reference**. Each dir is self-contained
(`npm install` to restore `node_modules`; generated PDFs are git-ignored).

## calibration/
- `make-calibration-pdf.mjs` — the 1:1 calibration page (1-inch & 5 cm squares,
  6-inch & 15-cm rulers, seam-allowance gauge). `node make-calibration-pdf.mjs`.
- `probe-printer.mjs` — IPP `Get-Printer-Attributes` probe (model, formats,
  `print-scaling`, media, margins).
- `ipp-print.mjs` — **pure binary IPP** `Print-Job` / `Validate-Job` reference
  (the source the Python `app/printing.py` was ported from). Sends
  `print-scaling=none` etc. `node ipp-print.mjs <file.pdf>`; `VALIDATE=1` to validate.

## tiling/
- `make-tiled-pdf.mjs` — tiled multi-page US-Letter generator (overlap, hollow
  registration triangles, A1/B2 labels, assembly map) with hard self-assertions.
  `node make-tiled-pdf.mjs` (2×2 proof) or `--full` (12-sheet).
- `verify-coverage.mjs` — independent check that tiling covers the pattern with no gaps.
- `verify-browser-gen.mjs` — runs the **app's** browser module headless (via a
  `window` shim) to assert the tote/rectangle/calibration page invariants.
- `SPEC.md` — the tiled-generator spec.

Physically confirmed (2026-06-20): exact 1:1 on the HP LaserJet at 192.168.8.198,
single-page and a tiled 2×2 assembly (scale true across seams, triangles register).
