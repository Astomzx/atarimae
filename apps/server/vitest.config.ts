import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test/setup-env.ts"],
    // Integration tests share one PostgreSQL database; running files in
    // parallel would let them see each other's rows.
    fileParallelism: false,
  },
});
