/* app.js — UI glue. Generates the PDF in-browser (PatternPDF), then either
 * downloads it or POSTs it to the server which relays it to the printer (IPP).
 * Shared by the Home and Settings pages; only wires controls that exist. */
(function () {
  const BASE = window.SEWING_BASE || "";
  const api = (p) => BASE + p;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ── status bar ──────────────────────────────────────────────────────────
  function setStatus(msg, kind = "info") {
    const bar = $("#statusbar");
    if (!bar) return;
    bar.textContent = msg;
    bar.className = "statusbar show " + kind;
    bar.hidden = false;
  }
  function clearStatus(after = 0) {
    const bar = $("#statusbar");
    if (!bar) return;
    if (after) { setTimeout(() => { bar.className = "statusbar"; }, after); }
    else bar.className = "statusbar";
  }

  // ── a small house-style confirm sheet (returns a Promise<boolean>) ─────────
  function confirmSheet(message, okLabel = "Print") {
    return new Promise((resolve) => {
      const trigger = document.activeElement;          // restore focus on close (a11y)
      const wrap = document.createElement("div");
      wrap.className = "sheet-backdrop";
      wrap.innerHTML =
        '<div class="sheet" role="dialog" aria-modal="true">' +
        '<p class="sheet__msg"></p>' +
        '<div class="btnrow">' +
        '<button class="btn btn--ghost" data-no>Cancel</button>' +
        '<button class="btn btn--primary" data-yes></button>' +
        "</div></div>";
      $(".sheet__msg", wrap).textContent = message;
      $("[data-yes]", wrap).textContent = okLabel;
      const onKey = (e) => { if (e.key === "Escape") done(false); };
      const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); if (trigger && trigger.focus) trigger.focus(); resolve(v); };
      document.addEventListener("keydown", onKey);
      $("[data-no]", wrap).addEventListener("click", () => done(false));
      $("[data-yes]", wrap).addEventListener("click", () => done(true));
      wrap.addEventListener("click", (e) => { if (e.target === wrap) done(false); });
      document.body.appendChild(wrap);
      $("[data-yes]", wrap).focus();
    });
  }

  const pdfBlob = (bytes) => new Blob([bytes], { type: "application/pdf" });

  // generate a tiled PDF, surfacing the keep-out/too-large throw instead of freezing the UI
  async function buildTiled(pat) {
    try { return await window.PatternPDF.makeTiledPdf(pat); }
    catch (e) { setStatus("That pattern is too large for Letter sheets — reduce the width or height.", "bad"); return null; }
  }

  function download(bytes, filename) {
    const url = URL.createObjectURL(pdfBlob(bytes));
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ── print: upload the generated PDF; server preflights + relays via IPP ────
  async function printBytes(bytes, kind, { sheets, name } = {}) {
    const what = kind === "calibration" ? "the test page (1 sheet)"
      : `${name || "this pattern"}${sheets ? " — " + sheets + " sheet" + (sheets > 1 ? "s" : "") : ""}`;
    if (!(await confirmSheet(`Print ${what}?`))) return;
    setStatus("Sending to the printer…", "info");
    const fd = new FormData();
    fd.append("pdf", pdfBlob(bytes), "pattern.pdf");
    fd.append("kind", kind);
    fd.append("confirm", "true");
    fd.append("job_name", name || kind);
    let res;
    try { res = await fetch(api("/print"), { method: "POST", body: fd }); }
    catch { setStatus("Couldn't reach the app.", "bad"); return; }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const d = data.detail || {};
      if (d.code === "needs_calibration") {
        setStatus("Print the test page first, then confirm it measured right.", "warn");
      } else {
        setStatus(d.message || "The printer couldn't take the job.", "bad");
      }
      return;
    }
    setStatus("Printing… " + (kind === "calibration" ? "measure the marks when it's out." : "go collect your sheets."), "good");
    if (data.job_id) pollJob(data.job_id);
  }

  async function pollJob(jobId) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      let d;
      try { d = await (await fetch(api("/print/status/" + jobId))).json(); }
      catch { setStatus("Stopped checking the printer — the job may still be printing.", "warn"); return; }
      if (d.needs_attention) { setStatus("The printer stopped — check for a jam, open cover, or empty tray.", "warn"); return; }
      if (d.done) { setStatus(d.job_state === 9 ? "Done." : "Print finished.", "good"); clearStatus(4000); return; }
    }
  }

  const toMm = (v, unit) => (unit === "in" ? v * 25.4 : v);

  // ── Home page wiring ───────────────────────────────────────────────────────
  function wireHome() {
    const rectForm = $("#rect-form");

    function buildRect() {
      const name = ($("#rect-name", rectForm).value || "").trim();
      const unit = $("#rect-unit", rectForm).value;
      const w = toMm(parseFloat($("#rect-w", rectForm).value), unit);
      const h = toMm(parseFloat($("#rect-h", rectForm).value), unit);
      if (!(w > 10 && h > 10 && w < 3000 && h < 3000)) {
        setStatus("Enter a width and height between 10 mm and 3000 mm.", "warn");
        return null;
      }
      return window.PatternPDF.rectanglePattern(name, Math.round(w), Math.round(h));
    }

    const toteForm = $("#tote-form");
    function buildTote() {
      if (!toteForm) return null;
      const unit = $("#tote-unit", toteForm).value;
      const n = (id) => toMm(parseFloat($(id, toteForm).value), unit);
      const W = n("#tote-w"), H = n("#tote-h"), D = n("#tote-d"), SA = n("#tote-sa"), SL = n("#tote-sl"), SW = n("#tote-sw");
      const dims = [W, H, D, SL, SW];
      if (!(dims.every((v) => v > 5 && v < 4000) && SA >= 0 && SA < 100)) {
        setStatus("Check the measurements — sizes in a sensible range (seam allowance under 100 mm).", "warn");
        return null;
      }
      const name = ($("#tote-name", toteForm).value || "").trim();
      return window.PatternPDF.boxyTotePattern(name, {
        widthMm: Math.round(W), heightMm: Math.round(H), depthMm: Math.round(D),
        seamMm: Math.round(SA), strapLenMm: Math.round(SL), strapWidthMm: Math.round(SW),
      });
    }

    // rebuild a saved pattern document into a generatable pattern, by kind
    function patternFromSaved(p) {
      if (p.kind === "box") return window.PatternPDF.boxyTotePattern(p.name, p.params);
      return window.PatternPDF.rectanglePattern(p.name, p.params.widthMm, p.params.heightMm);
    }

    async function savePattern(body) {
      let r; try { r = await fetch(api("/patterns"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); } catch { r = null; }
      if (r && r.ok) { setStatus("Saved.", "good"); setTimeout(() => location.reload(), 700); }
      else setStatus("Couldn't save — try again.", "bad");
    }

    // unit toggle: swap placeholders + convert the seam-allowance value in place
    const toteUnit = $("#tote-unit", toteForm || document);
    if (toteUnit) toteUnit.addEventListener("change", () => {
      const inch = toteUnit.value === "in";
      const ph = inch ? { w: "14", h: "16", d: "5", sl: "24", sw: "1" } : { w: "350", h: "400", d: "120", sl: "600", sw: "25" };
      for (const k of ["w", "h", "d", "sl", "sw"]) { const el = $("#tote-" + k, toteForm); if (el) el.placeholder = ph[k]; }
      const sa = $("#tote-sa", toteForm), v = parseFloat(sa.value);
      if (isFinite(v)) sa.value = inch ? +(v / 25.4).toFixed(2) : Math.round(v * 25.4);
    });

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === "test-page") {
        const bytes = await window.PatternPDF.makeCalibrationPdf();
        await printBytes(bytes, "calibration");
      }
      if (action === "mark-calibrated") {
        let r; try { r = await fetch(api("/printer/calibrated"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calibrated: true }) }); } catch { r = null; }
        if (r && r.ok) { setStatus("Printer marked as calibrated — patterns can print now.", "good"); setTimeout(() => location.reload(), 900); }
        else setStatus("Couldn't save that — try again.", "bad");
      }
      if (action === "rect-download" || action === "rect-print") {
        const pat = buildRect(); if (!pat) return;
        setStatus("Building the pattern…", "info");
        const res = await buildTiled(pat); if (!res) return;
        const { bytes, sheets } = res;
        if (action === "rect-download") { download(bytes, (pat.name || "pattern").replace(/\s+/g, "-") + ".pdf"); setStatus(`Downloaded — ${sheets} sheet${sheets > 1 ? "s" : ""}. Print at 100% / Actual Size.`, "good"); clearStatus(6000); }
        else await printBytes(bytes, "pattern", { sheets, name: pat.name });
      }
      if (action === "rect-save") {
        const pat = buildRect(); if (!pat) return;
        await savePattern({ name: pat.name, kind: pat.kind, params: { widthMm: pat.widthMm, heightMm: pat.heightMm } });
      }
      if (action === "tote-download" || action === "tote-print") {
        const pat = buildTote(); if (!pat) return;
        setStatus("Building the tote pattern…", "info");
        const res = await buildTiled(pat); if (!res) return;
        const { bytes, sheets } = res;
        if (action === "tote-download") { download(bytes, (pat.name || "tote").replace(/\s+/g, "-") + ".pdf"); setStatus(`Downloaded — ${sheets} sheet${sheets > 1 ? "s" : ""}. Print at 100% / Actual Size.`, "good"); clearStatus(6000); }
        else await printBytes(bytes, "pattern", { sheets, name: pat.name });
      }
      if (action === "tote-save") {
        const pat = buildTote(); if (!pat) return;
        await savePattern({ name: pat.name, kind: "box", params: pat.params });
      }
      // saved-pattern row actions
      const row = btn.closest("[data-pattern-id]");
      if (row) {
        const id = row.dataset.patternId;
        if (action === "saved-delete") {
          if (!(await confirmSheet("Delete this pattern?", "Delete"))) return;
          let r; try { r = await fetch(api("/patterns/" + id), { method: "DELETE" }); } catch { r = null; }
          if (r && r.ok) row.remove(); else setStatus("Couldn't delete that — try again.", "bad");
        }
        if (action === "saved-print" || action === "saved-download") {
          let p;
          try { const r = await fetch(api("/patterns/" + id)); if (!r.ok) throw 0; p = await r.json(); }
          catch { setStatus("Couldn't load that pattern.", "bad"); return; }
          const pat = patternFromSaved(p);
          const res = await buildTiled(pat); if (!res) return;
          const { bytes, sheets } = res;
          if (action === "saved-download") { download(bytes, (p.name || "pattern").replace(/\s+/g, "-") + ".pdf"); setStatus("Downloaded.", "good"); clearStatus(5000); }
          else await printBytes(bytes, "pattern", { sheets, name: p.name });
        }
      }
    });
  }

  // ── Settings page wiring ───────────────────────────────────────────────────
  function wireSettings() {
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "save-printer") {
        const uri = $("#printer-uri").value.trim();
        const r = await fetch(api("/settings/printer"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ printer_uri: uri }) });
        const d = await r.json().catch(() => ({}));
        setStatus(r.ok ? "Saved the printer address." : (d.detail || "Couldn't save that address."), r.ok ? "good" : "bad");
      }
      if (btn.dataset.action === "test-printer") {
        setStatus("Checking the printer…", "info");
        const r = await fetch(api("/printer/test"), { method: "POST" });
        const d = await r.json().catch(() => ({}));
        const info = $("#printer-info");
        if (!r.ok) { setStatus((d.detail && d.detail.message) || "Couldn't reach the printer.", "bad"); return; }
        clearStatus();
        info.hidden = false;
        info.innerHTML =
          `<div class="row row--between"><span>${d.model || "Printer"}</span><span class="chip chip--accent">${d.state_label}</span></div>` +
          `<div class="small muted">Paper ready: ${(d.media_ready || []).join(", ") || "unknown"}${d.letter_ready ? " ✓ Letter" : ""}</div>` +
          (d.toner != null ? `<div class="small muted">Toner: ~${d.toner}%</div>` : "") +
          (d.reasons && d.reasons.length ? `<div class="small" style="color:var(--warn)">${d.reasons.join(", ")}</div>` : "");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    if ($("#tote-form") || $("#rect-form")) wireHome();
    if ($("#printer-uri")) wireSettings();
  });
})();
