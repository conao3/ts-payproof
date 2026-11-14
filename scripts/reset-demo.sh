#!/usr/bin/env bash
set -euo pipefail
if (( $# > 0 )); then
  printf 'Usage: %s\nCreates a fresh unprocessed demo and restores presenter windows; never deletes history.\n' "$0" >&2
  exit 2
fi
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
exec nix develop --command node --env-file=.env scripts/reset-demo.ts
