import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  // Clean only our own JS/DTS/map outputs, not the whole dir: the `build:css`
  // step (Tailwind) writes `dist/styles.css` into the same directory, and a
  // blanket clean deletes it mid-watch — `tsup --watch` cleans on startup but
  // Tailwind's watcher only rebuilds on a `src/styles.css` change, so the file
  // stays gone and consumers' `@flowajs/react-viewer/styles.css` import 404s.
  clean: ["index.*"],
  treeshake: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".mjs" };
  },
});
