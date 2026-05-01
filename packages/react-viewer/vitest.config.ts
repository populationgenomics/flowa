import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    // Enables `globalThis.afterEach`, which @testing-library/react hooks
    // for automatic DOM cleanup between tests.
    globals: true,
  },
});
