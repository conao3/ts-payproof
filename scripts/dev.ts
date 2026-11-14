import { spawn } from "node:child_process"
const commands = [
  ["--watch", "--watch-preserve-output", "apps/mock-payment/src/index.ts"],
  ["--watch", "--watch-preserve-output", "apps/api/src/index.ts"],
  ["node_modules/vite-plus/bin/vp", "dev"],
]
const children = commands.map((args) =>
  spawn(process.execPath, args, { stdio: "inherit", env: process.env }),
)
let stopping = false
function stop(code: number) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill("SIGTERM")
  process.exitCode = code
}
for (const child of children) child.on("exit", (code) => stop(code ?? 1))
process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))
