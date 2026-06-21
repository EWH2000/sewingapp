// Minimal, dependency-free IPP Print-Job (the production reference impl).
// Builds the IPP/2.0 binary request by hand so we can send `print-scaling=none`
// (a modern attribute older client libs don't know) and PDF bytes inline.
import { readFileSync } from "node:fs";
import http from "node:http";

const HOST = process.env.PRN || "192.168.8.198";
const PORT = 631;
const RES  = "/ipp/print";
const FILE = process.argv[2] || "calibration.pdf";
const COPIES = parseInt(process.env.COPIES || "1", 10);
const VALIDATE = !!process.env.VALIDATE;   // Validate-Job (op 0x0004, no paper) when set
const pdf = readFileSync(FILE);

// ── IPP value tags ──────────────────────────────────────────────────────────
const T = { opAttrs:0x01, jobAttrs:0x02, end:0x03,
  integer:0x21, enum:0x23, keyword:0x44, uri:0x45, name:0x42,
  charset:0x47, naturalLang:0x48, mimeType:0x49 };

function txt(tag, name, value) {
  const n = Buffer.from(name, "utf8");
  const v = Buffer.from(String(value), "utf8");
  const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
  let o = 0; b[o++] = tag;
  b.writeUInt16BE(n.length, o); o += 2; n.copy(b, o); o += n.length;
  b.writeUInt16BE(v.length, o); o += 2; v.copy(b, o);
  return b;
}
function num(tag, name, val) {          // integer (0x21) OR enum (0x23)
  const n = Buffer.from(name, "utf8");
  const b = Buffer.alloc(1 + 2 + n.length + 2 + 4);
  let o = 0; b[o++] = tag;
  b.writeUInt16BE(n.length, o); o += 2; n.copy(b, o); o += n.length;
  b.writeUInt16BE(4, o); o += 2; b.writeInt32BE(val, o);
  return b;
}

const header = Buffer.concat([
  Buffer.from([0x02, 0x00]),                          // IPP version 2.0
  Buffer.from([0x00, VALIDATE ? 0x04 : 0x02]),        // op: Validate-Job(0x0004) or Print-Job(0x0002)
  Buffer.from([0x00, 0x00, 0x00, 0x01]),              // request-id
  Buffer.from([T.opAttrs]),
    txt(T.charset,     "attributes-charset",          "utf-8"),
    txt(T.naturalLang, "attributes-natural-language", "en"),
    txt(T.uri,         "printer-uri",     `ipp://${HOST}${RES}`),
    txt(T.name,        "requesting-user-name", "sewingapp"),
    txt(T.name,        "job-name",        `sewing:${FILE}`),
    txt(T.mimeType,    "document-format", "application/pdf"),
  Buffer.from([T.jobAttrs]),
    txt(T.keyword, "print-scaling",    "none"),                 // <<< 1:1 guarantee
    txt(T.keyword, "media",            "na_letter_8.5x11in"),
    txt(T.keyword, "sides",            "one-sided"),
    txt(T.keyword, "print-color-mode", "monochrome"),
    num(T.integer, "copies",           COPIES),
    num(T.integer, "number-up",        1),                      // one input page per impression
    num(T.enum,    "orientation-requested", 7),                 // 7 = none: no auto-rotate (confirmed supported)
  Buffer.from([T.end]),
]);

// Validate-Job carries the attributes only (no document); Print-Job appends the PDF.
const body = VALIDATE ? header : Buffer.concat([header, pdf]);

const req = http.request({ host: HOST, port: PORT, path: RES, method: "POST",
  headers: { "Content-Type": "application/ipp", "Content-Length": body.length } },
  (res) => {
    const chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => {
      const r = Buffer.concat(chunks);
      const status = r.readUInt16BE(2);              // IPP status-code
      const ok = status <= 0x00ff;
      // scan response for the job-id integer attribute (tag 0x21, name "job-id")
      let jobId = null, jobState = null;
      const nm = Buffer.from("job-id");
      const i = r.indexOf(nm);
      if (i > 0 && r[i-3] === T.integer) jobId = r.readInt32BE(i + nm.length + 2);
      const sm = Buffer.from("job-state");
      const j = r.indexOf(sm);
      if (j > 0 && r[j-3] === T.enum) jobState = r.readInt32BE(j + sm.length + 2);
      // a Validate-Job/Print-Job that hit an unsupported attribute returns a
      // 0x05 unsupported-attributes group — surface that it's clean
      const clean = r.indexOf(Buffer.from([0x05])) === -1 || status === 0x0000;
      console.log("operation       :", VALIDATE ? "Validate-Job" : "Print-Job");
      console.log("HTTP            :", res.statusCode);
      console.log("IPP status-code : 0x" + status.toString(16).padStart(4,"0"),
        status === 0x0000 ? "(successful-ok)" : ok ? "(success-class)" : "(ERROR)");
      if (!VALIDATE) {
        console.log("job-id          :", jobId);
        console.log("job-state       :", jobState, "(3=pending 4=held 5=processing 9=completed)");
      }
      console.log(VALIDATE
        ? `\nValidated ${FILE}: attributes ${status === 0x0000 ? "ALL ACCEPTED" : "REJECTED — see status"}.`
        : `\nSent ${pdf.length} bytes of ${FILE} · print-scaling=none · media=na_letter · ${COPIES} copy.`);
      process.exit(ok ? 0 : 1);
    });
  });
req.on("error", e => { console.error("REQUEST ERROR:", e.message); process.exit(1); });
req.write(body); req.end();
