## MCP Server Bundle

After editing any MCP server source files, run `npm run build` before committing to regenerate `dist/server.mjs`.

## Working Directory

Never use `cd` in Bash commands — it persists across calls and breaks subsequent commands. Use absolute paths instead:
- `npx vitest run` → run from `/Users/konsta/konsta-claude-plugins/plugins/unity-mcp` using absolute path in the command
- `git` commands → run from repo root `/Users/konsta/konsta-claude-plugins`
