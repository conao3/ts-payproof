import { defineConfig } from "vite-plus"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
export default defineConfig({
  root: "apps/web",
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": "http://127.0.0.1:4100" } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
  fmt: {
    semi: false,
    singleQuote: false,
    trailingComma: "all",
    sortPackageJson: false,
    ignorePatterns: ["**/generated/**", "dist/**", ".claude-dev/**"],
  },
  lint: {
    categories: { correctness: "error", suspicious: "warn" },
    ignorePatterns: ["node_modules", "dist", ".direnv", "**/generated/**", ".claude-dev/**"],
    options: { typeAware: true, typeCheck: true },
    rules: { "no-underscore-dangle": ["warn", { allow: ["_id"] }] },
  },
  test: {
    root: ".",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    maxWorkers: 4,
  },
  run: {
    tasks: {
      check: {
        command:
          "node node_modules/@graphql-codegen/cli/cjs/bin.js --config codegen.ts && node node_modules/vite-plus/bin/vp check && node node_modules/vite-plus/bin/vp test",
      },
    },
  },
  pack: [
    {
      name: "api",
      entry: ["apps/api/src/index.ts"],
      platform: "node",
      format: "esm",
      target: "node26",
      outDir: "dist/api",
      deps: { neverBundle: ["mongodb"] },
    },
    {
      name: "payment",
      entry: ["apps/mock-payment/src/index.ts"],
      platform: "node",
      format: "esm",
      target: "node26",
      outDir: "dist/payment",
      deps: { neverBundle: ["mongodb"] },
    },
  ],
})
