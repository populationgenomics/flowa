/**
 * Copy pdfjs-dist's worker bundle and CMaps into ./public/pdfjs/, where
 * the viewer page references them via static `<script>` URLs.
 *
 * Idempotent: skips if the destination tree already has all expected
 * files. Re-runs cheaply on every demo boot (start.ts) to defend against
 * the global `ignore-scripts=true` policy that suppresses postinstall
 * hooks.
 */

import { existsSync, mkdirSync, cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(here, "..");

const require_ = createRequire(import.meta.url);
const pdfjsRoot = dirname(require_.resolve("pdfjs-dist/package.json"));

const destDir = resolve(demoRoot, "public", "pdfjs");
const workerSrc = resolve(pdfjsRoot, "build", "pdf.worker.min.mjs");
const cmapsSrc = resolve(pdfjsRoot, "cmaps");
const workerDst = resolve(destDir, "pdf.worker.min.mjs");
const cmapsDst = resolve(destDir, "cmaps");

const workerInPlace = existsSync(workerDst);
const cmapsInPlace = existsSync(cmapsDst);
if (workerInPlace && cmapsInPlace) {
  console.log(`pdfjs assets already present at ${destDir}`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
if (!workerInPlace) {
  cpSync(workerSrc, workerDst);
  console.log(`copied ${workerSrc} -> ${workerDst}`);
}
if (!cmapsInPlace) {
  cpSync(cmapsSrc, cmapsDst, { recursive: true });
  console.log(`copied ${cmapsSrc} -> ${cmapsDst}`);
}
