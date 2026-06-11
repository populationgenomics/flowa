/**
 * Copy the pdf.js worker bundle and CMaps into ./public/pdfjs/, where the
 * viewer page references them via static URLs.
 *
 * The assets are resolved *through* `@flowajs/react-viewer` — the package
 * that actually renders the PDF — so the worker we serve is always the exact
 * pdf.js build that react-viewer's bundled `react-pdf` runs with. pdf.js
 * rejects any mismatch ("The API version X does not match the Worker version
 * Y"), so deriving the worker from the renderer (rather than from a
 * separately-declared `pdfjs-dist`) is what keeps the two in lockstep: there
 * is no second version to drift.
 *
 * A `.pdfjs-version` marker records which build is staged. The copy is
 * skipped when it already matches and re-staged (whole tree wiped first)
 * when react-viewer moves to a different pdf.js. That keeps the common case
 * cheap — it re-runs on every demo boot (start.ts), needed because the
 * global `ignore-scripts=true` policy suppresses postinstall hooks — while
 * still self-healing after a `react-pdf` bump.
 */

import {
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(here, "..");

// Resolve pdfjs-dist as react-viewer's renderer sees it:
// demo -> @flowajs/react-viewer -> react-pdf -> pdfjs-dist.
const require_ = createRequire(import.meta.url);
const viewerRequire = createRequire(require_.resolve("@flowajs/react-viewer"));
const reactPdfRequire = createRequire(viewerRequire.resolve("react-pdf"));
const pdfjsPkg = reactPdfRequire.resolve("pdfjs-dist/package.json");
const pdfjsRoot = dirname(pdfjsPkg);
const pdfjsVersion: string = JSON.parse(readFileSync(pdfjsPkg, "utf8")).version;

const destDir = resolve(demoRoot, "public", "pdfjs");
const workerSrc = resolve(pdfjsRoot, "build", "pdf.worker.min.mjs");
const cmapsSrc = resolve(pdfjsRoot, "cmaps");
const workerDst = resolve(destDir, "pdf.worker.min.mjs");
const cmapsDst = resolve(destDir, "cmaps");
const versionMarker = resolve(destDir, ".pdfjs-version");

const staged = existsSync(versionMarker)
  ? readFileSync(versionMarker, "utf8").trim()
  : null;
if (staged === pdfjsVersion && existsSync(workerDst) && existsSync(cmapsDst)) {
  console.log(`pdfjs ${pdfjsVersion} assets already present at ${destDir}`);
  process.exit(0);
}

// Wipe first so a version change can't leave a stale worker behind.
rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
cpSync(workerSrc, workerDst);
cpSync(cmapsSrc, cmapsDst, { recursive: true });
writeFileSync(versionMarker, `${pdfjsVersion}\n`);
console.log(`staged pdfjs ${pdfjsVersion} assets -> ${destDir}`);
