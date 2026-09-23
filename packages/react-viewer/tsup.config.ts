import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  // Clean everything except the stylesheet: the `build:css` step (Tailwind)
  // writes `dist/styles.css` into the same directory, and `tsup --watch`
  // cleans on startup while Tailwind's watcher only rebuilds on a source
  // change, so a deleted stylesheet stays gone and consumers'
  // `@flowajs/react-viewer/styles.css` import fails. tsup deletes
  // `**/*` plus these patterns, so keeping a file takes a negated pattern.
  clean: ["!styles.css"],
  treeshake: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".mjs" };
  },
});
