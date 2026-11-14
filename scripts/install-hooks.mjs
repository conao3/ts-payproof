import { mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { execFileSync } from "node:child_process"
mkdirSync(".vite-hooks", { recursive: true })
writeFileSync(".vite-hooks/pre-commit", "#!/bin/sh\nnix develop --command vp run check\n")
chmodSync(".vite-hooks/pre-commit", 0o755)
execFileSync("git", ["config", "core.hooksPath", ".vite-hooks"])
