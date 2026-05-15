import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    // `happy-dom` lets component tests render the literature view; the
    // existing non-component tests (route handlers, server helpers) run
    // fine under it because happy-dom doesn't shadow Node APIs.
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
  // tsconfig keeps `jsx: "preserve"` so Next.js's compiler can do its
  // thing in production builds; vitest's vite-driven oxc transformer
  // needs an explicit JSX runtime to compile `.tsx` test files.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  // Mirror tsconfig.json's `@/*` path alias so tests can import route
  // handlers that use the alias internally.
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
});
