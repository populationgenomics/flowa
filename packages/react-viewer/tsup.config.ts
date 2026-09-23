import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  // A one-off build cleans everything except the stylesheet, which the
  // `build:css` step (Tailwind) writes into the same directory; tsup deletes
  // `**/*` plus these patterns, so keeping a file takes a negated pattern.
  // Watch mode does not clean at all: it starts next to a consumer's dev
  // server that is already resolving `dist/`, and a startup clean would
  // leave the package without an entry point until the first rebuild lands
  // (and without a stylesheet until Tailwind's watcher next rebuilds).
  // Rebuilds overwrite the same files, so there is nothing stale to remove.
  clean: options.watch ? false : ["!styles.css"],
  treeshake: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".mjs" };
  },
}));
