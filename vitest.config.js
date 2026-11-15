import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["src/**/*.js"],
      exclude: ["src/index.js", "src/cli.js"],
    },
  },
});
