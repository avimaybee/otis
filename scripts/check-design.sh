#!/usr/bin/env bash
# Otis design checker entry (008A). Resolves the repo root from this script's
# location so the result never depends on the caller's working directory.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is required to run scripts/check-design.mjs" >&2
  exit 1
fi
exec node "$ROOT/scripts/check-design.mjs"
