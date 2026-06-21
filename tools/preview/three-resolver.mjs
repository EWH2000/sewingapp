// three-resolver.mjs — a Node module-resolution hook for the headless preview tests.
//
// app/static/js/preview3d.js does `import * as THREE from 'three'`. In the browser that
// bare specifier is resolved by the page's import map; under Node it must resolve too, but
// Node resolves bare specifiers relative to the IMPORTING file's directory (app/static/js/,
// which has no node_modules). This hook maps 'three' to the copy pinned in THIS dir's
// node_modules (the same version vendored into the app), for every importer — so preview3d.js
// and the test share one three instance. Registered from the test via module.register().

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const threeUrl = pathToFileURL(join(here, 'node_modules/three/build/three.module.js')).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: threeUrl, shortCircuit: true };
  return next(specifier, context);
}
