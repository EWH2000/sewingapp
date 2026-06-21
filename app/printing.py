"""Direct IPP printing — pure Python stdlib, no CUPS, no third-party deps.

A faithful port of the proven Node reference (tools/calibration/ipp-print.mjs)
and PRINTING.md. We hand-build the binary IPP/2.0 request so we can send
`print-scaling=none` (the 1:1 guarantee that higher-level libs choke on) and the
PDF inline, and POST it straight to the printer's ipp://…/ipp/print endpoint.

The printer (HP LaserJet Pro 3001-3008 at 192.168.8.198) was probed + physically
confirmed: it accepts application/pdf, honours print-scaling=none, has Letter
loaded, and supports Validate-Job + orientation-requested=none. See PRINTING.md
for the per-attribute rationale.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import struct
import urllib.parse

# ── IPP value / delimiter tags ───────────────────────────────────────────────
_OP_ATTRS, _JOB_ATTRS, _END = 0x01, 0x02, 0x03
_INTEGER, _BOOLEAN, _ENUM = 0x21, 0x22, 0x23
_KEYWORD, _URI, _NAME = 0x44, 0x45, 0x42
_CHARSET, _NATLANG, _MIMETYPE = 0x47, 0x48, 0x49
_TEXT = 0x41

PRINT_JOB, VALIDATE_JOB, GET_JOB_ATTRS, GET_PRINTER_ATTRS = 0x0002, 0x0004, 0x0009, 0x000B

DEFAULTS = {
    "media": "na_letter_8.5x11in",
    "sides": "one-sided",
    "color_mode": "monochrome",
    "scaling": "none",
    "copies": 1,
    "job_name": "sewing",
}

# Job-state enum -> plain-language label (no jargon for the partner).
JOB_STATE_LABEL = {
    3: "waiting", 4: "held", 5: "printing", 6: "stopped (check the printer)",
    7: "canceled", 8: "stopped (jam or out of paper?)", 9: "done",
}
JOB_STATE_DONE = {7, 8, 9}
JOB_STATE_ATTENTION = {6, 8}


class PrinterError(Exception):
    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.message, self.code = message, code


# ── request builders ─────────────────────────────────────────────────────────
def _text(tag: int, name: str, value: str) -> bytes:
    n = name.encode(); v = str(value).encode()
    return struct.pack("!BH", tag, len(n)) + n + struct.pack("!H", len(v)) + v


def _num(tag: int, name: str, value: int) -> bytes:
    n = name.encode()
    return struct.pack("!BH", tag, len(n)) + n + struct.pack("!H", 4) + struct.pack("!i", value)


def _keywords(name: str, values: list[str]) -> bytes:
    out = _text(_KEYWORD, name, values[0])
    for v in values[1:]:
        out += _text(_KEYWORD, "", v)        # additional values carry an empty name
    return out


def _split_uri(printer_uri: str):
    p = urllib.parse.urlparse(printer_uri)
    host = p.hostname or ""
    port = p.port or 631
    path = p.path or "/ipp/print"
    tls = p.scheme == "ipps"
    # The printer-uri attribute value omits the default port (matches the Node ref).
    attr_uri = f"{p.scheme}://{host}{path}" if p.port in (None, 631) else printer_uri
    return host, port, path, tls, attr_uri


def _op_group(attr_uri: str, extra: bytes = b"") -> bytes:
    return (bytes([_OP_ATTRS])
            + _text(_CHARSET, "attributes-charset", "utf-8")
            + _text(_NATLANG, "attributes-natural-language", "en")
            + _text(_URI, "printer-uri", attr_uri)
            + _text(_NAME, "requesting-user-name", "sewingapp")
            + extra)


def _job_group(o: dict) -> bytes:
    return (bytes([_JOB_ATTRS])
            + _text(_KEYWORD, "print-scaling", o["scaling"])     # THE 1:1 guarantee
            + _text(_KEYWORD, "media", o["media"])
            + _text(_KEYWORD, "sides", o["sides"])
            + _text(_KEYWORD, "print-color-mode", o["color_mode"])
            + _num(_INTEGER, "copies", int(o["copies"]))
            + _num(_INTEGER, "number-up", 1)
            + _num(_ENUM, "orientation-requested", 7))           # 7 = none: no auto-rotate


def _build_job(op: int, attr_uri: str, o: dict, pdf: bytes | None) -> bytes:
    head = (struct.pack("!BBHI", 0x02, 0x00, op, 1)              # IPP 2.0, op, request-id
            + _op_group(attr_uri,
                        _text(_NAME, "job-name", o["job_name"][:255])
                        + _text(_MIMETYPE, "document-format", "application/pdf"))
            + _job_group(o) + bytes([_END]))
    return head + (pdf or b"")


# ── response parsing ─────────────────────────────────────────────────────────
def _decode(tag: int, v: bytes):
    if tag in (_INTEGER, _ENUM):
        return struct.unpack("!i", v)[0] if len(v) == 4 else None
    if tag == _BOOLEAN:
        return v[0] == 0x01 if len(v) == 1 else None     # RFC 8011: 0x01 true, 0x00 false
    if tag in (_KEYWORD, _URI, _NAME, _TEXT, _CHARSET, _NATLANG, _MIMETYPE) or 0x40 <= tag <= 0x4F:
        return v.decode("utf-8", "replace")
    return v


def _parse(raw: bytes) -> dict:
    """Return {attribute-name: [values]} across all groups of an IPP response."""
    attrs: dict[str, list] = {}
    i, n, cur = 8, len(raw), None        # skip version(2)+status(2)+request-id(4)
    while i < n:
        tag = raw[i]; i += 1
        if tag in (_OP_ATTRS, _JOB_ATTRS, 0x03, 0x04, 0x05, 0x06, 0x07):
            if tag == _END:
                break
            continue
        if i + 2 > n:
            break                                        # truncated response — stop cleanly
        nlen = struct.unpack("!H", raw[i:i + 2])[0]; i += 2
        name = raw[i:i + nlen].decode("utf-8", "replace"); i += nlen
        if i + 2 > n:
            break
        vlen = struct.unpack("!H", raw[i:i + 2])[0]; i += 2
        v = raw[i:i + vlen]; i += vlen
        key = name if nlen else cur
        if nlen:
            cur = name
        if key is not None:
            attrs.setdefault(key, []).append(_decode(tag, v))
    return attrs


def _status(raw: bytes) -> int:
    return struct.unpack("!H", raw[2:4])[0]


# ── transport ────────────────────────────────────────────────────────────────
def _post_ipp(printer_uri: str, body: bytes, timeout: float) -> bytes:
    host, port, path, tls, _ = _split_uri(printer_uri)
    if tls:
        conn = http.client.HTTPSConnection(host, port, timeout=timeout,
                                           context=ssl._create_unverified_context())
    else:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("POST", path, body,
                     {"Content-Type": "application/ipp", "Content-Length": str(len(body))})
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise PrinterError(f"Printer returned HTTP {resp.status}.", "http")
        return raw
    except (ConnectionRefusedError, socket.gaierror, OSError) as e:
        if isinstance(e, (socket.timeout, TimeoutError)):
            raise PrinterError("The printer didn't respond — it may be asleep. "
                               "Wake it and try again.", "timeout") from e
        raise PrinterError("Couldn't reach the printer — is it on and on the network?",
                           "offline") from e
    finally:
        conn.close()


# ── SSRF guard: only ever talk to a private-range IPP endpoint ───────────────
def validate_printer_uri(uri: str) -> str:
    """Raise PrinterError unless `uri` is a sane ipp/ipps endpoint on the LAN.
    Called when saving the setting AND before every print, so a stored value can
    never turn the server into a port-scanner."""
    p = urllib.parse.urlparse((uri or "").strip())
    if p.scheme not in ("ipp", "ipps") or not p.hostname:
        raise PrinterError("Printer address must look like ipp://192.168.8.198/ipp/print.", "config")
    host = p.hostname
    try:
        ip = ipaddress.ip_address(host)
        if not (ip.is_private or ip.is_loopback):
            raise PrinterError("Printer must be on the local network (a private IP).", "config")
    except ValueError:
        # a hostname — require an allowed LAN suffix. This also rejects bare
        # single-label names (printer/localhost) and public domains; only numeric
        # IPs reach the is_private/is_loopback branch above.
        if not host.endswith((".local", ".home.arpa", ".lan")):
            raise PrinterError("Use the printer's LAN IP or a .home.arpa/.local name.", "config")
    return uri.strip()


# ── public operations ────────────────────────────────────────────────────────
def validate_job(printer_uri: str, opts: dict | None = None, timeout: float = 8) -> int:
    """Validate-Job (no paper): IPP status; 0x0000 == every attribute accepted."""
    o = {**DEFAULTS, **(opts or {})}
    raw = _post_ipp(printer_uri, _build_job(VALIDATE_JOB, _split_uri(printer_uri)[4], o, None), timeout)
    return _status(raw)


def ipp_print(pdf_bytes: bytes, printer_uri: str, opts: dict | None = None) -> dict:
    """Submit a Print-Job carrying the PDF. Returns {job_id, job_state}."""
    o = {**DEFAULTS, **(opts or {})}
    raw = _post_ipp(printer_uri, _build_job(PRINT_JOB, _split_uri(printer_uri)[4], o, pdf_bytes), timeout=15)
    st = _status(raw)
    if st > 0x00FF:
        raise PrinterError(f"The printer rejected the job (IPP 0x{st:04x}).", "rejected")
    a = _parse(raw)
    return {"job_id": (a.get("job-id") or [None])[0], "job_state": (a.get("job-state") or [None])[0]}


def get_printer_state(printer_uri: str, timeout: float = 6) -> dict:
    """Get-Printer-Attributes -> a friendly readiness snapshot for the UI."""
    wanted = ["printer-make-and-model", "printer-state", "printer-state-reasons",
              "printer-is-accepting-jobs", "media-ready", "marker-levels", "marker-names"]
    body = (struct.pack("!BBHI", 0x02, 0x00, GET_PRINTER_ATTRS, 1)
            + _op_group(_split_uri(printer_uri)[4], _keywords("requested-attributes", wanted))
            + bytes([_END]))
    a = _parse(_post_ipp(printer_uri, body, timeout))
    state = (a.get("printer-state") or [None])[0]                # 3 idle, 4 processing, 5 stopped
    return {
        "model": (a.get("printer-make-and-model") or [""])[0],
        "state": state,
        "state_label": {3: "ready", 4: "printing", 5: "stopped"}.get(state, "unknown"),
        "accepting": (a.get("printer-is-accepting-jobs") or [None])[0],
        "reasons": [r for r in a.get("printer-state-reasons", []) if r and r != "none"],
        "media_ready": a.get("media-ready", []),
        "letter_ready": any("letter" in str(m).lower() for m in a.get("media-ready", [])),
        "toner": (a.get("marker-levels") or [None])[0],
    }


def job_status(printer_uri: str, job_id: int, timeout: float = 8) -> int | None:
    body = (struct.pack("!BBHI", 0x02, 0x00, GET_JOB_ATTRS, 2)
            + _op_group(_split_uri(printer_uri)[4], _num(_INTEGER, "job-id", int(job_id)))
            + bytes([_END]))
    return (_parse(_post_ipp(printer_uri, body, timeout)).get("job-state") or [None])[0]
