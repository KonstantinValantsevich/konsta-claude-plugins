## MCP Server Bundle

After editing any MCP server source files, run `npm run build` before committing to regenerate `dist/server.mjs`.

## Versioning

Increment the plugin version in `plugins/unity-mcp/package.json` at the end of each new feature development before the final commit.

## Testing

For any new tool/resource added to mcp create new e2e test suite and run it
To run `npm run test:e2e`, this is the only way to run them, you can't run them per test suite