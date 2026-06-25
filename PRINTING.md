# PRINTING.md — Sewing app print spine (direct IPP, no CUPS)

> Self-contained build spec for `~/sewingapp/`'s print feature. Synthesizes the
> verified IPP recipe, the chosen Python submission method, the quadlet/config
> story, failure handling, security, and the calibration-first UX. A future
> session can build directly from this. Companion: `DESIGN.md` (the "Print
> contract" section) and the proven references in `tools/calibration/`
> (`ipp-print.mjs`, `make-calibration-pdf.mjs`, `probe-printer.mjs`).
>
> **Status of the evidence (read this first):** The single-page 1:1 path is
> **PHYSICALLY CONFIRMED (2026-06-20)** — a hand-built Print-Job with
> `print-scaling=none` (HTTP 200 / IPP `0x0000` / job-state 5) printed
> `calibration.pdf` straight from the server, and the user measured the 1-inch
> square at **exactly 1 inch with NO manual margin setting**. So the protocol path
> AND the physical scale both hold for a single page. **What is still untested: the
> 10–20 page *tiled* PDF — the actual product — does not exist yet.** Single-page
> success is necessary but does NOT generalize to tiled output (per-tile MediaBox
> drift, cross-seam spans, inter-sheet registration). The tiled generator (§ next
> artifact) carries its own mandatory physical 2×2 proof gate.
>
> **Confirmed live by post-synthesis probe (2026-06-20), correcting two open items:**
> `orientation-requested-supported` **contains `none`** → send `orientation-requested=none`
> (enum 7) unconditionally. `Validate-Job` (op 0x0004) **is supported** → the §6
> preflight is valid. `media-col-ready` = Letter (21590×27940 hundredths-mm),
> **4.23 mm** hardware margins all sides (our ≥13 mm keep-out clears it),
> `media-source=tray-1`. `marker-levels`=90 (black cartridge). `number-up-supported`=1.
> `ipp-features-supported`=[airprint-2.1, ipp-everywhere, page-overrides].
> Printer MAC `f0:4e:a4:f1:6f:34` (for a DHCP reservation to pin .198).

---

## 1. Why direct IPP, and why no CUPS

This is a headless Fedora monitoring box: **no CUPS, no cups-client (`lp`/`lpr`),
no `ipptool`, no avahi/mDNS** — on the host or in the `python:3.14-slim` image.
The printer (HP LaserJet Pro 3001–3008, mono laser, 600 dpi) is a separate LAN
host that speaks **driverless IPP Everywhere** and accepts `application/pdf`
natively. So the app talks **IPP directly over HTTP** to the printer's
`ipp://…/ipp/print` endpoint. No print spooler, no daemon, no shell-out.

Rejected alternatives (and why):
- **pycups (libcups)** — needs a running `cupsd` + libcups in the image; there is
  no CUPS on this box by design, and standing one up inside a rootless container
  just to relay to one IPP-Everywhere printer is a large stateful detour. Also
  needs a C build, breaking the all-prebuilt-wheels property of the pinned
  requirements set.
- **Bundling `ipptool`/cups-ipp-utils and shelling out** — host has none; bloats
  the image, forces writing `.test` files at runtime, and means scraping text
  output (fragile) instead of reading the IPP status code directly.
- **pyipp (ctalkington/python-ipp)** — a printer-*monitoring* library (built for
  Home Assistant), fully async (aiohttp), with no public Print-Job API. Printing
  would mean hand-assembling against an undocumented internal — the same byte-level
  work stdlib already does, plus an aiohttp dep and an async/sync mismatch.
- **Off-the-shelf JS `ipp` npm lib** — already tried; it **rejected
  `print-scaling` as an unknown attribute**. That rejection is exactly why the
  binary request was hand-rolled, and exactly why a higher-level lib is the wrong
  layer for the make-or-break attribute.

**Decision: hand-build the binary IPP/2.0 Print-Job in pure Python stdlib
(`struct` + `http.client`), a direct port of the proven `ipp-print.mjs`.** Zero
new dependencies (keeps the exact cercoachapp pinned set:
`fastapi`/`sqlmodel`/`uvicorn`/`jinja2`/`python-multipart`). Synchronous, so it
drops into FastAPI's `def`-endpoint + `run_in_threadpool` model and the app's sync
SQLite code. `http.client` exposes a per-connection timeout, so an asleep/offline
printer fails fast instead of hanging a worker. The *same* builder is reused for
**Validate-Job**, **Get-Printer-Attributes**, and **Get-Job-Attributes** — all the
preflight/feedback this needs.

---

## 2. The verified attribute set (per-attribute rationale)

Probed live via Get-Printer-Attributes at `ipp://192.168.8.198:631/ipp/print`.
Validated live via **Validate-Job** (op `0x0004`): the full set below returns IPP
`0x0000` with an **empty** unsupported-attributes group. A *mistyped*
`print-scaling` value returns `0x0001` with the bad value in the `0x05` unsupported
group — i.e. the preflight catches it deterministically (see §6).

**Operation attributes (group tag `0x01`):**

| Attribute | Value | Tag | Why |
|---|---|---|---|
| `attributes-charset` | `utf-8` | `0x47` charset | Required first attribute (RFC 8011). |
| `attributes-natural-language` | `en` | `0x48` natLang | Required second attribute. |
| `printer-uri` | `ipp://<host>/ipp/print` | `0x45` uri | Target endpoint; default port 631 omitted from the attr value, as the Node ref does. |
| `requesting-user-name` | `sewingapp` | `0x42` name | Identifies the job owner. |
| `job-name` | `sewing:<kind>` (e.g. `sewing:calibration`) | `0x42` name | Distinguishes jobs on the printer's own job list (Get-Jobs); also the idempotency hook. Clamp to 255 bytes. |
| **`document-format`** | **`application/pdf`** | **`0x49` mimeType** | **Load-bearing.** Forces the PDF interpreter. The printer's `document-format-default` is `application/octet-stream`, which triggers content auto-sensing and can route bytes to a raster/PCLm path where DPI rounding and driver fit-logic creep in. Never rely on the default. |

**Job attributes (group tag `0x02`):**

| Attribute | Value | Tag | Why |
|---|---|---|---|
| **`print-scaling`** | **`none`** | **`0x44` keyword** | **THE 1:1 GUARANTEE.** The only value that disables all fit/fill/auto rescaling. Confirmed in `print-scaling-supported`. The printer's `print-scaling-default` is **`auto`**, which fit-scales an exactly-Letter page to ~96.97% (printable height 270.94 mm / 279.4 mm). If this attribute is ever dropped or mistyped under `fidelity=false`, the job silently reverts to `auto` — with a `0x0000` status. Spell it literally `none`; verify by ruler. |
| **`media`** | **`na_letter_8.5x11in`** | **`0x44` keyword** | Must equal the PDF MediaBox (612×792 pt = 21590×27940 hundredths-mm exactly). Matches `media-default` and `media-ready`, so no A4 fallback. Pinning the requested size prevents cross-size scaling. |
| `sides` | `one-sided` | `0x44` keyword | One physical sheet per page; no duplex pairing, no back-side registration drift on tiled calibration sheets. |
| `print-color-mode` | `monochrome` | `0x44` keyword | Printer is mono (`color-supported=false`). No scale effect; explicit is tidy. |
| `copies` | `1` (clamp 1–5) | `0x21` integer | Explicit; default is 1. Server-side clamp guards a runaway. |
| **`number-up`** | **`1`** | **`0x21` integer** | Guarantees one input page per impression — no N-up down-scaling. `number-up-supported=[1]` on this hardware, so N-up is *literally impossible* here; sending `1` explicitly is harmless and removes ambiguity for a future code path. |
| **`orientation-requested`** | **`none` (enum 7)** | **`0x23` enum** | Explicitly requests NO rotation, killing any auto-rotate/auto-landscape. **CONFIRMED supported live** — `orientation-requested-supported` contains `none`, so send it unconditionally on this printer. (If ever pointed at a printer lacking enum 7, OMIT the attribute entirely — never send `3`/`4` as a guess.) The Node `int()` helper writes tag `0x21`; this needs the same shape with tag `0x23` (the `_num` helper handles both). |

**Deliberately ABSENT:**
- **`ipp-attribute-fidelity`** — NEVER send `true`. Counter-intuitively it (a)
  rejects the whole job if *any* attribute is unsupported (RFC 8011) AND (b) flips
  `auto`/`auto-fit` into fit/fill scaling per PWG 5100.13 Table 8. We don't need it:
  the load-bearing values (`none`, `na_letter`) are genuinely supported, so they're
  honored under the default `fidelity=false`.
- `print-quality`, `media-source` (let the printer auto-select the Letter tray;
  pinning an unenumerated source is silently ignored), `page-ranges` (absent = all
  pages, which is what we want), `multiple-document-handling` (only for
  Create-Job/Send-Document multi-doc jobs; a single multi-page PDF is ONE document).
  Optionally `media-col` with `media-size {21590,27940}` as belt-and-suspenders, but
  the keyword is sufficient and matches `media-ready`.

**Scaling semantics (why `none` = 1:1 here):** PWG 5100.13-2023 §6.2.5 Table 8 —
`none` does not scale; if the document is larger than the media it centers and
clips, if smaller it centers. Our PDF MediaBox is *exactly* Letter = the requested
media, so it is neither larger nor smaller: `none` centers with **no scale and no
clip**. The only loss is the engine's physical unprintable margin (probed **423
hundredths-mm = 4.23 mm** per side), which the generator's **≥13 mm keep-out**
clears. `fit`/`fill`/`auto`/`auto-fit` can never give exact 1:1 except in degenerate
cases — `none` is mandatory.

**Multi-page behavior:** `print-scaling` applies to **each input page
independently**, so page 1 and page 17 have identical physical scale — no
cumulative drift. With `number-up=1`, each PDF page is exactly one impression. With
`sides=one-sided`, N pages → N sheets. Caveat: sheet-to-sheet mechanical feed
tolerance (paper pick skew, ≤1 mm on this engine) means tile-to-tile *positioning*
across sheets isn't micron-perfect — which is why the generator uses **overlap +
alignment marks**, not edge-to-edge butt joins (§ nextArtifactSpec). *Scale* is
exact and identical on every page; only inter-sheet positioning carries feed
tolerance.

---

## 3. Submission method — Python stdlib (code sketch)

`app/printing.py` — a direct port of `ipp-print.mjs`. Pure stdlib, synchronous,
called via `run_in_threadpool`. (Tags map 1:1 to the Node `T` table:
`name=0x42 keyword=0x44 uri=0x45 mimeType=0x49 charset=0x47 natLang=0x48
integer=0x21 enum=0x23`; groups `op=0x01 job=0x02 end=0x03`.)

```python
# app/printing.py — pure-stdlib IPP (port of ipp-print.mjs)
import struct, http.client, urllib.parse

_CHARSET, _NATLANG, _MIMETYPE = 0x47, 0x48, 0x49
_INTEGER, _ENUM, _KEYWORD, _URI, _NAME = 0x21, 0x23, 0x44, 0x45, 0x42
_OP_ATTRS, _JOB_ATTRS, _END = 0x01, 0x02, 0x03
PRINT_JOB, VALIDATE_JOB, GET_PRINTER_ATTRS, GET_JOB_ATTRS = 0x0002, 0x0004, 0x000B, 0x0009

class PrinterError(Exception):
    def __init__(self, message, code="error"):
        super().__init__(message); self.message, self.code = message, code

def _tlv(tag, name, value):                 # text/keyword/uri/name/mime
    n = name.encode(); v = str(value).encode()
    return struct.pack("!BH", tag, len(n)) + n + struct.pack("!H", len(v)) + v

def _num(tag, name, value):                 # integer (0x21) OR enum (0x23)
    n = name.encode()
    return struct.pack("!BH", tag, len(n)) + n + struct.pack("!H", 4) + struct.pack("!i", value)

def _split_uri(printer_uri):
    p = urllib.parse.urlparse(printer_uri)
    host, port, path = p.hostname, (p.port or 631), (p.path or "/ipp/print")
    attr_uri = f"ipp://{host}{path}" if p.port in (None, 631) else printer_uri
    return host, port, path, attr_uri

def _post_ipp(host, port, path, body, timeout):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("POST", path, body,
                     {"Content-Type": "application/ipp", "Content-Length": str(len(body))})
        resp = conn.getresponse(); raw = resp.read()
        if resp.status != 200:
            raise PrinterError(f"Printer returned HTTP {resp.status}.", "http")
        return raw
    finally:
        conn.close()

def _parse_status(raw):                      # IPP status-code = bytes 2..3
    return struct.unpack("!H", raw[2:4])[0]

def _scan_num(raw, name, tag):               # find one integer/enum attr by name
    needle = name.encode(); i = raw.find(needle)
    if i > 2 and raw[i - 3] == tag:
        off = i + len(needle) + 2            # skip name + 2-byte value-length
        return struct.unpack("!i", raw[off:off + 4])[0]
    return None

def _op_group(attr_uri, op_extra=b""):
    return (bytes([_OP_ATTRS])
        + _tlv(_CHARSET, "attributes-charset", "utf-8")
        + _tlv(_NATLANG, "attributes-natural-language", "en")
        + _tlv(_URI,     "printer-uri", attr_uri)
        + _tlv(_NAME,    "requesting-user-name", "sewingapp")
        + op_extra)

def _job_group(o, orientation_none):
    g = (bytes([_JOB_ATTRS])
        + _tlv(_KEYWORD, "print-scaling",    o["scaling"])        # literally "none"
        + _tlv(_KEYWORD, "media",            o["media"])
        + _tlv(_KEYWORD, "sides",            o["sides"])
        + _tlv(_KEYWORD, "print-color-mode", o["color_mode"])
        + _num(_INTEGER, "copies",   int(o["copies"]))
        + _num(_INTEGER, "number-up", 1))
    if orientation_none:                     # only if enum 7 confirmed supported
        g += _num(_ENUM, "orientation-requested", 7)
    return g

def _build_print_job(pdf_bytes, attr_uri, o, orientation_none, validate=False):
    op = PRINT_JOB if not validate else VALIDATE_JOB
    hdr = struct.pack("!BBHI", 0x02, 0x00, op, 1)        # ver 2.0, op, request-id
    head = (hdr + _op_group(attr_uri,
                _tlv(_NAME, "job-name", o["job_name"][:255])
              + _tlv(_MIMETYPE, "document-format", "application/pdf"))
            + _job_group(o, orientation_none) + bytes([_END]))
    return head + (b"" if validate else pdf_bytes)

DEFAULTS = {"media": "na_letter_8.5x11in", "sides": "one-sided",
            "color_mode": "monochrome", "copies": 1, "scaling": "none",
            "job_name": "sewing"}

def validate_job(pdf_len_probe, printer_uri, opts=None, orientation_none=True, timeout=8):
    """Validate-Job preflight: returns the IPP status. 0x0000 == all accepted."""
    o = {**DEFAULTS, **(opts or {})}
    host, port, path, attr_uri = _split_uri(printer_uri)
    body = _build_print_job(b"", attr_uri, o, orientation_none, validate=True)
    raw = _post_ipp(host, port, path, body, timeout)
    return _parse_status(raw)                # caller hard-fails on != 0x0000

def ipp_print(pdf_bytes, printer_uri, opts=None, orientation_none=True):
    o = {**DEFAULTS, **(opts or {})}
    host, port, path, attr_uri = _split_uri(printer_uri)
    body = _build_print_job(pdf_bytes, attr_uri, o, orientation_none)
    try:
        raw = _post_ipp(host, port, path, body, timeout=10)
    except (ConnectionRefusedError, OSError) as e:        # No route to host, etc.
        raise PrinterError("Couldn't reach the printer — is it on and awake?", "offline") from e
    except TimeoutError as e:
        raise PrinterError("The printer didn't respond (it may be asleep). "
                           "Wake it and try again.", "timeout") from e
    status = _parse_status(raw)
    if status > 0x00ff:                       # > 0x00ff = not success-class
        raise PrinterError(f"Printer rejected the job (IPP 0x{status:04x}).", "rejected")
    return {"job_id": _scan_num(raw, "job-id", _INTEGER),
            "job_state": _scan_num(raw, "job-state", _ENUM)}

def get_printer_state(printer_uri, timeout=6):
    """Get-Printer-Attributes: returns parsed readiness snapshot (state, accepting,
    state-reasons text, media-ready text, marker-levels). Used by preflight."""
    host, port, path, attr_uri = _split_uri(printer_uri)
    hdr = struct.pack("!BBHI", 0x02, 0x00, GET_PRINTER_ATTRS, 1)
    body = hdr + _op_group(attr_uri) + bytes([_END])
    raw = _post_ipp(host, port, path, body, timeout)
    # parse printer-state(enum 0x23), printer-is-accepting-jobs(boolean 0x22),
    # printer-state-reasons(keyword), media-ready(keyword), marker-levels(int),
    # orientation-requested-supported(enum list) — scan by name as above.
    ...

def job_status(printer_uri, job_id, timeout=8):
    """Get-Job-Attributes -> int job-state (3 pending,4 held,5 processing,
    6 stopped,7 canceled,8 aborted,9 completed) or None."""
    host, port, path, attr_uri = _split_uri(printer_uri)
    hdr = struct.pack("!BBHI", 0x02, 0x00, GET_JOB_ATTRS, 2)
    body = (hdr + _op_group(attr_uri, _num(_INTEGER, "job-id", int(job_id)))
            + bytes([_END]))
    raw = _post_ipp(host, port, path, body, timeout)
    return _scan_num(raw, "job-state", _ENUM)
```

`app/main.py` — endpoints honor `BASE_PATH`, mirror cercoachapp:

```python
import os, time
from fastapi import APIRouter, Body, HTTPException, Response
from starlette.concurrency import run_in_threadpool
from .printing import ipp_print, validate_job, job_status, get_printer_state, PrinterError

BASE_PATH   = os.environ.get("BASE_PATH", "")
PRINTER_URI = os.environ.get("SEWING_PRINTER_URI", "")   # FALLBACK only; see §5
router = APIRouter()

_print_lock = {"busy": False, "t": 0.0}      # single in-process serializer
_MIN_GAP = 8.0

@router.post("/print")
async def print_pattern(payload: dict = Body(...)):
    uri = (resolve_printer_uri(payload) or PRINTER_URI).strip()   # settings.printer_uri or env
    if not uri:                       raise HTTPException(409, "No printer configured yet.")
    _assert_allowed_printer(uri)      # SSRF guard, §7
    if not payload.get("confirm"):    raise HTTPException(400, "Confirmation required.")
    now = time.monotonic()
    if _print_lock["busy"] or now - _print_lock["t"] < _MIN_GAP:
        raise HTTPException(429, "A print is already running — give it a moment.")
    kind = payload.get("kind", "pattern")     # "calibration" | "pattern"
    if kind != "calibration" and not _is_calibrated(uri):
        raise HTTPException(409, {"code": "needs_calibration",
                                  "message": "Print and measure the calibration page first."})
    pdf = render_pdf(kind, payload)
    opts = {"job_name": f"sewing:{kind}", "copies": _clamp(payload.get("copies", 1), 1, 5)}
    # PREFLIGHT: readiness + Validate-Job (hard-fails on wrong scale/media/paper) — §6
    await run_in_threadpool(preflight, uri, pdf, opts)
    _print_lock["busy"] = True
    try:
        result = await run_in_threadpool(ipp_print, pdf, uri, opts)
    except PrinterError as e:
        _print_lock["busy"] = False
        raise HTTPException(502, detail={"code": e.code, "message": e.message})
    _print_lock.update(busy=False, t=now)
    return {"ok": True, "kind": kind, **result}

@router.get("/print/{job_id}/status")
async def print_status(job_id: int):
    try:
        state = await run_in_threadpool(job_status, resolve_printer_uri({}), job_id)
    except PrinterError as e:
        raise HTTPException(502, detail={"code": e.code, "message": e.message})
    label = {3:"pending",4:"held",5:"printing",6:"stopped (check the printer)",
             7:"canceled",8:"aborted (jam or out of paper?)",9:"done"}.get(state, "unknown")
    return {"job_state": state, "label": label, "done": state in (7,8,9),
            "needs_attention": state in (6,8)}

@router.get("/pattern/{pattern_id}.pdf")          # always available, even with no printer
async def download_pdf(pattern_id: int):
    pdf = await run_in_threadpool(render_pattern_pdf, pattern_id)
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="sewing-{pattern_id}.pdf"'})

# app.include_router(router, prefix=BASE_PATH)    # Caddy strips /sewing; templates use {{ base_path }}
```

GET endpoints never print (download/status only). Printing is POST-only with
`confirm:true`, so no link/prefetch/crawler can fire paper.

---

## 4. Quadlet & app shape (mirrors cercoachapp)

`Containerfile`: `FROM docker.io/library/python:3.14-slim`, non-root user UID 10001,
`COPY requirements.txt` (the **exact** cercoachapp pinned set — zero IPP deps),
`COPY app/`, `RUN mkdir -p /data && chown -R app:app /data`, `ENV
SEWING_DB_PATH=/data/sewing.db`, `EXPOSE 8006`, `CMD ["uvicorn","app.main:app",
"--host","0.0.0.0","--port","8006"]`.

`deploy/sewingapp.container`:

```ini
[Unit]
Description=sewingapp — pattern authoring + 1:1 home printing
After=network-online.target
Wants=network-online.target

[Container]
ContainerName=sewingapp
Image=localhost/sewingapp:latest
PublishPort=8006:8006
Environment=BASE_PATH=/sewing
# Default printer (FALLBACK). The printer is a SEPARATE LAN host, addressed by
# its own IP — NOT host.containers.internal (which maps to the host's real
# interface, not the printer). No host CUPS is involved. The app prefers the
# value stored in the SQLite settings table (editable from a phone); this env
# is only the default when none is saved.
Environment=SEWING_PRINTER_URI=ipp://192.168.8.198:631/ipp/print
Volume=sewingdata:/data:U
HealthCmd=python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8006/health')"
HealthInterval=30s
HealthTimeout=3s
HealthRetries=3
HealthStartPeriod=5s

[Service]
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

No root step anywhere: port 8006 is >1024, rootless, all `systemctl --user`. Caddy
already terminates TLS (internal CA) and proxies sub-paths — add a `/sewing/` route
exactly like `/cer/` (`handle_path` strips the prefix; the app prepends
`{{ base_path }}` to every emitted URL). Nightly SQLite backup timer like
cercoachapp's (the root SSD is the SPOF; the volume rides the backup).

**Remembering the printer without a rebuild (two layers):**
1. **Default:** edit `Environment=SEWING_PRINTER_URI=`, then `systemctl --user
   daemon-reload && systemctl --user restart sewingapp` (read from env at request
   time — no image rebuild).
2. **Preferred:** store the printer URI (and per-URI `calibrated` flag) as rows in
   a SQLite `settings` table on the named volume, edited from an in-app **Settings**
   page. Resolved URI = `settings.printer_uri or env`. Because `/data` is a
   persistent named volume, the chosen printer and its calibration state survive
   image rebuilds and container re-creation — and are editable from a phone with
   no shell access. The Settings page shows `printer-make-and-model` (from a
   Get-Printer-Attributes probe) so the user can confirm the right machine, plus
   `media-default` and a "Print calibration page" button.

---

## 5. Failure handling (plain language, never a stack trace)

Map every condition to something the user can act on.

**Submit-time** (in `ipp_print`, `http.client timeout=10s`):
- Connection refused / `OSError` "No route to host" (wrong/changed IP, 631 closed)
  → code `offline`, "Couldn't reach the printer — is it on and awake?" (measured
  ~3 s to fail against a dead host.)
- `TimeoutError` (deep-sleep HP that drops TCP, slow wake) → code `timeout`, "The
  printer didn't respond (it may be asleep). Wake it and try again." The short 10 s
  timeout keeps a worker from hanging.
- HTTP ≠ 200 → code `http`. IPP status > `0x00ff` → code `rejected`, show the
  `0x`-code. Rare for a plain PDF on IPP Everywhere.

All raise `PrinterError(message, code)`; the endpoint returns **HTTP 502** with
`{code, message}` (502 = the printer's fault, not the user's; UI shows the message
verbatim).

**After submit** (poll `GET /print/{job_id}/status` → Get-Job-Attributes, every
~3 s for ~30 s, then auto-stop): the printer **accepts** a job even when out of
paper or jammed — those surface as *job-state*, not a submit error.
- 5 processing → "Printing…" → 9 completed → "Done. Measure the calibration square
  before printing the rest." (only on calibration kind)
- 6 stopped / 8 aborted → `needs_attention` → "The printer stopped — check for a
  paper jam, open cover, or empty tray, then reprint." (HP reports `media-empty`/
  jam as `job-state-reasons`; keep copy generic to cover all.)
- 4 held / long-pending → "Waiting on the printer (it may be waking up)."
- **On submit-timeout, do NOT blind-retry** — capture `job-id` and poll
  Get-Job-Attributes to learn the true state. Print is **idempotent per render**
  (dedupe by `job-name`/client token) so a retry can't double-print a 20-sheet job.

**Defensive:** every print path also offers the **PDF download** (§ UX), so a
wedged printer never blocks the user — they can AirPrint/USB it from a device.

---

## 6. Preflight (catches wrong-scale BEFORE paper)

The HTTP-200 / IPP-0x0000 / job-state-5 signal does **not** certify scale. Three
independent guards close that gap, all using the same builder:

1. **Readiness** — Get-Printer-Attributes for `printer-state`,
   `printer-is-accepting-jobs`, `printer-state-reasons`. If not idle/processing or
   not accepting, show the specific reason (`media-empty`, `door-open`,
   `marker-supply-low`) instead of printing into the void.
2. **Right paper loaded** — assert `media-ready` contains `na_letter_8.5x11in`
   (and `media-col-ready.media-size == 21590×27940` if present). Tray contents
   change out-of-band; if A4 is loaded, block with "Load US Letter paper." This is
   environmental and only catchable by querying first.
3. **Validate-Job** (op `0x0004`, confirmed supported) with the exact job-attributes
   immediately before Print-Job. **Hard-fail** if the response has a `0x05`
   unsupported-attributes group OR status ≠ `0x0000`. This deterministically catches
   a stripped/mistyped/wrong-tag `print-scaling` (proven: a bad value returns
   `0x0001` with `print-scaling` in the unsupported group) — *before* wasting a
   sheet. (`orientation-requested-supported` already confirmed to include `none`
   on this printer, so the attribute stays in; the preflight only needs to re-drop
   it if ever pointed at a different printer.)

**The ultimate backstop is still the ruler.** Firmware *can* fit-scale
`application/pdf` to the printable area regardless of `print-scaling=none` (the
classic AirPrint/driverless-laser "prints ~96%" failure) and still report success
— no preflight can prove otherwise. So: keep the embedded calibration ruler, gate
on a physical measurement (§ UX), and capture `printer-firmware-string-configured`
to re-measure after a firmware change.

---

## 7. Security

Threat model is narrow: a same-origin LAN-only button behind the hub's Caddy
(HTTPS, internal CA), reachable only from the home network. Real risks are wasting
paper and SSRF, not external attackers.

- **No-arbitrary-target / SSRF:** `ipp_print` only talks to a URI that passes
  `_assert_allowed_printer(uri)` — (1) scheme in `{ipp, ipps}`, (2) host equals the
  configured printer host (env default or the Settings value). It is NOT a free-form
  fetcher; a request body can't make the server POST elsewhere. If a user-typed IP
  is ever allowed in Settings, validate it's a **private/LAN range**
  (192.168/10/172.16) and reject loopback/link-local/public so the box can't be
  turned into a port-scanner. Payload is always `application/ipp` to :631-class IPP
  endpoints.
- **Confirm + calibration gate:** `POST /print` requires `confirm:true`; the UI
  shows a one-tap "Print to <printer>?" sheet, and full patterns are gated behind
  calibration (§ UX). A stray tap or prefetch can't fire paper. Printing is
  POST-only.
- **Rate-limit + serialize:** an in-process lock + wall clock (`_MIN_GAP` ~8 s)
  returns 429 on double-taps / stuck retry loops; `copies` clamped 1–5. A single
  in-flight job per printer prevents two devices interleaving a tiled set in the
  output bin. Sufficient for one trusted household user; can sit behind the same
  `basic_auth` the photo gallery uses if a lock is wanted.
- **No secrets:** the printer URI isn't sensitive; nothing logs documents or
  exposes the volume.

---

## 8. UX — calibration-first (the make-or-break gate)

Per printer (keyed by resolved URI in the settings table), the app tracks whether
calibration is **confirmed**. When the printer is new or page-setup changed and not
yet confirmed, the Print action is **intercepted**: it prints the **calibration
page only** (`kind:"calibration"` — the existing `calibration.pdf`: 1-inch & 5 cm
squares, 6-inch & 15-cm rulers, seam-allowance gauge, all ≥13 mm from edges) and
shows: *"Print this, measure the 6-inch ruler / 50 mm square with a real ruler.
This used Actual Size — if it's off, that's a printer setting, not the app."* An
**"It measured correct — remember this printer"** button flips `calibrated=true`
for that URI; only then is full-pattern direct-print unlocked. The scariest risk
becomes impossible to skip on fresh setup, and never nags once confirmed.

**Both direct-print AND download, always side by side:**
- **"Print at home"** → `POST /print` (confirm sheet → preflight → submit → live
  job-state poll). Best when the user is near the printer.
- **"Download PDF"** → `GET /pattern/{id}.pdf` (attachment). Always available even
  with no printer or a wedged one; AirPrint from an iPad / print elsewhere. The
  download page repeats the loud instruction: **"Print at 100% / Actual Size — NOT
  Fit to Page."**

**Copy** mirrors CER Coach's mobile-first terracotta house style: big bottom-zone
buttons, ≥44 px tap targets, a sticky "Printing… / Done — go measure the square"
status, and **no jargon** (no "IPP", no "job-state 8" — just "the printer stopped,
check for a jam"). The Settings page surfaces the model name, `media-default`, a
test-print button, and a toner warning when `marker-levels` is low.
