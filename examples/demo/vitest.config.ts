import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
  // Mirror tsconfig.json's `@/*` path alias so tests can import route
  // handlers that use the alias internally.
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
});
