#!/bin/bash
# Unity Recompile Hook — thin wrapper delegating to TypeScript
# See src/index.ts for the actual implementation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx --yes tsx "$SCRIPT_DIR/../src/hook/index.ts"
