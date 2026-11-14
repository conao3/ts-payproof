import { defineConfig } from "vite-plus"
export default defineConfig({
  test: {
    include: ["test/atlas/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
