/* pattern-thumb.js — Home only. Draws a small SVG "pattern tissue" sketch of each
 * saved pattern's real cut lines, so she recognizes a pattern at a glance.
 *
 * Cheap + dependency-free: it reuses the already-flattened, tiler-ready document
 * (the same `paths` the 1:1 tiler prints) — freeform docs carry it directly;
 * box/rectangle are rebuilt via the already-loaded window.PatternPDF. No Maker.js,
 * no three.js. Each card's doc is fetched lazily as it scrolls into view. */
(function () {
  const BASE = window.SEWING_BASE || "";
  const api = (p) => BASE + p;
  const NS = "http://www.w3.org/2000/svg";

  // saved row {name, kind, params} -> a tiler-ready doc with .paths (mm)
  function buildDoc(p) {
    const P = window.PatternPDF, G = window.PatternGeom;
    if (!p) return null;
    if (p.kind === "freeform") {
      const params = p.params || {};
      if (Array.isArray(params.paths) && params.paths.length) return params;   // already tiler-ready
      // authoring-only doc (pieces but no baked paths) — rebuild the board.
      if (G && (params.pieces || params.kind === "freeform")) {
        try { return G.freeformToDoc(params); } catch (_) { return null; }
      }
      return params;
    }
    if (p.kind === "box" && P) return P.boxyTotePattern(p.name, p.params || {});
    if (p.kind === "rectangle" && P && p.params)
      return P.rectanglePattern(p.name, p.params.widthMm, p.params.heightMm);
    return null;
  }

  function bbox(paths) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const pa of paths) for (const pt of pa.points) {
      if (pt[0] < x0) x0 = pt[0]; if (pt[1] < y0) y0 = pt[1];
      if (pt[0] > x1) x1 = pt[0]; if (pt[1] > y1) y1 = pt[1];
    }
    return { x0, y0, x1, y1 };
  }

  // an <svg> of the cut/fold outline (+ faint seam line), fit to its bbox and
  // flipped in Y so it reads the same way up as it prints (pattern Y is up-positive).
  function render(doc) {
    if (!doc || !Array.isArray(doc.paths) || !doc.paths.length) return null;
    const draw = doc.paths.filter(
      (p) => p.points && p.points.length > 1 &&
        (p.kind === "cut" || p.kind === "fold" || p.kind === "seam"));
    if (!draw.length) return null;
    const b = bbox(draw);
    const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    const m = Math.max(w, h) * 0.04 + 1;          // a little breathing room
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `${b.x0 - m} ${b.y0 - m} ${w + 2 * m} ${h + 2 * m}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("class", "thumb-svg");
    svg.setAttribute("aria-hidden", "true");
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(0 ${b.y0 + b.y1}) scale(1 -1)`);
    // seam first (under), then cut/fold on top
    const ordered = draw.slice().sort((a, c) => (a.kind === "seam" ? 0 : 1) - (c.kind === "seam" ? 0 : 1));
    for (const pa of ordered) {
      const el = document.createElementNS(NS, "polyline");
      el.setAttribute("points", pa.points.map((p) => `${p[0]},${p[1]}`).join(" "));
      el.setAttribute("fill", "none");
      el.setAttribute("vector-effect", "non-scaling-stroke");
      el.setAttribute("class", pa.kind === "seam" ? "thumb-seam" : "thumb-cut");
      g.appendChild(el);
    }
    svg.appendChild(g);
    return svg;
  }

  // ── finished-size meta line (in the saved display unit) ────────────────────
  function unitName() { try { return localStorage.getItem("sewing.unit") || "in"; } catch (_) { return "in"; } }
  function dim(mm) { const u = unitName(); return u === "cm" ? +(mm / 10).toFixed(1) : +(mm / 25.4).toFixed(1); }
  function metaText(p, doc) {
    const u = unitName() === "cm" ? "cm" : "in";
    try {
      if (p.kind === "box" && p.params)
        return `tote · ${dim(p.params.widthMm)} × ${dim(p.params.heightMm)} × ${dim(p.params.depthMm)} ${u}`;
      if (p.kind === "rectangle" && p.params)
        return `panel · ${dim(p.params.widthMm)} × ${dim(p.params.heightMm)} ${u}`;
      if (doc && doc.widthMm)
        return `pattern · ${dim(doc.widthMm)} × ${dim(doc.heightMm)} ${u}`;
    } catch (_) { /* fall through */ }
    return p.kind || "pattern";
  }

  async function load(card) {
    const host = card.closest("[data-pattern-id]");
    if (!host) return;
    const id = host.dataset.patternId;
    let p;
    try { const r = await fetch(api("/patterns/" + id)); if (!r.ok) throw 0; p = await r.json(); }
    catch (_) { return; }                          // leave the paper placeholder
    let doc = null; try { doc = buildDoc(p); } catch (_) { doc = null; }
    const svg = doc && render(doc);
    if (svg) { card.replaceChildren(svg); card.classList.add("is-drawn"); }
    const meta = host.querySelector("[data-meta]");
    if (meta) meta.textContent = metaText(p, doc);
  }

  function init() {
    const thumbs = Array.from(document.querySelectorAll("[data-thumb]"));
    if (!thumbs.length) return;
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries, obs) => {
        for (const e of entries) if (e.isIntersecting) { obs.unobserve(e.target); load(e.target); }
      }, { rootMargin: "300px" });
      thumbs.forEach((t) => io.observe(t));
    } else {
      thumbs.forEach(load);
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
