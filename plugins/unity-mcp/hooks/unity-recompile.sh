#!/bin/bash
# Unity Recompile Hook — runs the bundled hook entry point.
# See src/hook/index.ts for the source implementation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/../dist/hook.mjs"
