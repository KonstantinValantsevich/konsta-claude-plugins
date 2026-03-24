# Make projectPath Required in unity-mcp Tools

**Date:** 2026-03-24
**Status:** Approved

## Problem

Agents calling unity-mcp tools omit the `projectPath` parameter because it's marked optional. On a fresh MCP session the cache is empty, so the first call fails with "No project path provided and none cached. Run unity_detect_project first." The agent then has to recover — wasting a round-trip and making the API harder to use.

The optional parameter also hides state (a module-level cache) that makes multi-project usage ambiguous.

## Decision

1. **Remove `unity_detect_project` tool** — no longer needed; agents pass paths explicitly.
2. **Remove `cachedProjectRoot`** — no hidden state.
3. **Make `projectPath` required** on `unity_status`, `unity_recompile`, `unity_lint` — change from `z.string().optional()` to `z.string()`.
4. **Remove fallback/error branches** in each handler — no more `projectPath || cachedProjectRoot` pattern.
5. **Remove `detectProject` import** from server.ts — no longer used there.
6. **Update `.describe()` text** — remove "(uses cached detection if omitted)" from parameter descriptions.
7. **Update server test** — expect 3 tools instead of 4, remove `unity_detect_project` from expected names.

## Files Changed

- `plugins/unity-mcp/src/mcp/server.ts` — remove detect tool, cache, make param required
- `plugins/unity-mcp/__tests__/mcp/server.test.ts` — update tool count and names
- `plugins/unity-mcp/dist/server.mjs` — rebuild

## What Stays

- Core functions in `core/` and `lib/` — untouched (detect.ts still exists for internal use)
- Tool behavior once a path is provided — identical
- Build/bundle setup — untouched
