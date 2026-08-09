import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The bake allocates ~50MB of typed arrays and walks the quadtree.
    testTimeout: 60_000,
  },
});
