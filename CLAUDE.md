## Working Directory

Never use `cd` in Bash commands — it persists within the project and breaks subsequent commands. Use `--prefix` for npm/npx and absolute paths for everything else:
- Tests: `npx --prefix plugins/unity-mcp vitest run`
- Build: `npm --prefix plugins/unity-mcp run build`
