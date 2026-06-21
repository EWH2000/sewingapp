/* maker-shim.js — normalize the Maker.js browser bundle to window.makerjs.
 * The vendored browser.maker.js (a browserify build) installs a global `require`
 * function; the rest of the app expects a conventional global, so expose it as
 * window.makerjs (matching window.PDFLib). Must load AFTER browser.maker.js. */
(function () {
  try {
    if (typeof window.makerjs === "undefined" && typeof require === "function") {
      window.makerjs = require("makerjs");
    }
  } catch (e) { /* leave window.makerjs undefined → pattern-geom falls back to straight cut lines */ }
})();
