## MCP Server Bundle

After editing any MCP server source files, run `npm run build` before committing to regenerate `dist/server.mjs`.

## Versioning

Increment the plugin version in `plugins/unity-mcp/package.json` at the end of each new feature development before the final commit.

## Testing

For any new tool/resource added to mcp create new e2e test suite and run it.

E2E test commands:
- `npm run test:e2e` — full suite (setup → tests → teardown)
- `npm run test:e2e:keep` — full suite, keeps Unity running after (no teardown)
- `npm run test:e2e:only -- __tests__/e2e/07-logs.test.ts` — run specific suite(s), reuses existing session, no teardown

Workflow for iterating on a single suite:
1. `npm run test:e2e:keep` — first run creates project + launches Unity
2. `npm run test:e2e:only -- __tests__/e2e/07-logs.test.ts` — fast re-runs reuse session
3. `npm run test:e2e` — when done, run full suite (cleans up)