import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recompile } from "../core/recompile.js";
import { getStatus } from "../core/status.js";
import { lint } from "../core/lint.js";
import { runTests } from "../core/test.js";
import { getTestResults } from "../core/test-results.js";
import { listTests } from "../core/list-tests.js";
import { searchAssets } from "../core/search.js";
import { getLogs } from "../core/logs.js";
import { getConsole } from "../core/console.js";
import type { Logger } from "../core/types.js";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const stderrLogger: Logger = {
  log(msg) { console.error(`[unity-mcp] ${msg}`); },
  error(msg) { console.error(`[unity-mcp] ERROR: ${msg}`); },
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "unity-mcp",
    version: "1.0.0",
  });

  server.tool(
    "unity_recompile",
    "Trigger Unity recompilation. Detects C# changes, installs bridge, and orchestrates compilation.",
    { projectPath: z.string().describe("Unity project root path") },
    async ({ projectPath }) => {
      const result = await recompile(projectPath, stderrLogger);

      if (result.skipped) {
        return {
          content: [{ type: "text" as const, text: "No C# changes detected. Recompilation skipped." }],
        };
      }

      if (result.success) {
        return {
          content: [{ type: "text" as const, text: "Unity recompilation completed successfully." }],
        };
      }

      const errorText = result.errors.map((e) => e.message).join("\n");
      return {
        content: [{ type: "text" as const, text: `Unity compilation failed:\n${errorText}` }],
        isError: true,
      };
    },
  );

  server.tool(
    "unity_status",
    "Show Unity project and bridge diagnostics — editor status, bridge readiness, version info.",
    { projectPath: z.string().describe("Unity project root path") },
    async ({ projectPath }) => {
      const status = await getStatus(projectPath, stderrLogger);
      const lines = [
        `Unity Project: ${status.projectPath}`,
        `Unity Version: ${status.unityVersion ?? "Unknown"}`,
        `Editor Running: ${status.editorRunning ? `Yes (PID ${status.editorPid})` : "No"}`,
        `Bridge Ready: ${status.bridgeReady ? `Yes (bridge v${status.bridgeVersion}, protocol v${status.protocolVersion})` : "No"}`,
        `Last Recompile: ${status.lastRecompileMarker ? status.lastRecompileMarker.toISOString() : "Never"}`,
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  server.tool(
    "unity_lint",
    "Run JetBrains cleanup code on changed C# files in the Unity project.",
    { projectPath: z.string().describe("Unity project root path") },
    async ({ projectPath }) => {
      const result = await lint(projectPath, { logger: stderrLogger });
      return {
        content: [{
          type: "text" as const,
          text: result.filesLinted > 0
            ? `Linted ${result.filesLinted} file(s).`
            : "No changed C# files to lint.",
        }],
      };
    },
  );

  server.tool(
    "unity_run_tests",
    "Run Unity EditMode tests. Supports filtering by category, class/namespace (regex), and assembly. Returns summary or verbose results.",
    {
      projectPath: z.string().describe("Unity project root path"),
      categoryNames: z.array(z.string()).optional().describe("NUnit [Category] tags to filter by"),
      groupNames: z.array(z.string()).optional().describe("Regex patterns for namespace/class/test name filtering"),
      assemblyNames: z.array(z.string()).optional().describe("Assembly names to filter (without .dll)"),
      verbose: z.boolean().optional().describe("If true, show all test results; if false, show summary + failures only"),
    },
    async ({ projectPath, categoryNames, groupNames, assemblyNames, verbose }) => {
      const result = await runTests({
        projectPath,
        categoryNames,
        groupNames,
        assemblyNames,
        verbose,
        logger: stderrLogger,
      });

      return {
        content: [{ type: "text" as const, text: result.formatted }],
        isError: !result.runId,
      };
    },
  );

  server.tool(
    "unity_list_tests",
    "List available Unity EditMode tests. Returns test names, categories, and assemblies. Supports filtering by category, class/namespace (regex), and assembly — use to preview which tests a filter matches before running.",
    {
      projectPath: z.string().describe("Unity project root path"),
      categoryNames: z.array(z.string()).optional().describe("NUnit [Category] tags to filter by"),
      groupNames: z.array(z.string()).optional().describe("Regex patterns for namespace/class/test name filtering"),
      assemblyNames: z.array(z.string()).optional().describe("Assembly names to filter (without .dll)"),
    },
    async ({ projectPath, categoryNames, groupNames, assemblyNames }) => {
      const result = await listTests({ projectPath, categoryNames, groupNames, assemblyNames, logger: stderrLogger });
      return {
        content: [{ type: "text" as const, text: result.formatted }],
      };
    },
  );

  server.tool(
    "unity_test_results",
    "Retrieve results from a previous test run. Supports filtering by status, name pattern, and adaptive verbosity. Flags stale results when code has changed.",
    {
      projectPath: z.string().describe("Unity project root path"),
      runId: z.string().optional().describe("Test run ID (defaults to latest)"),
      verbose: z.boolean().optional().describe("If true, show all test results; if false, show summary + failures only"),
      statusFilter: z.enum(["passed", "failed", "skipped"]).optional().describe("Filter results by test status"),
      nameFilter: z.string().optional().describe("Regex pattern to filter by test name"),
    },
    async ({ projectPath, runId, verbose, statusFilter, nameFilter }) => {
      const result = getTestResults({
        projectPath,
        runId,
        verbose,
        statusFilter,
        nameFilter,
      });

      return {
        content: [{ type: "text" as const, text: result.formatted }],
      };
    },
  );

  // --- MCP Resources ---

  const SEARCH_SYNTAX_CONTENT = `# Unity Asset Search Syntax Reference

## Filter Tokens

| Token | Description | Example |
|-------|-------------|---------|
| \`t:\` / \`t=\` | Type (partial/exact) | \`t:prefab\`, \`t=Texture2D\` |
| \`l:\` / \`l=\` | Label (partial/exact) | \`l:arch\`, \`l=Wall\` |
| \`ref:\` | References asset | \`ref:Crystal\`, \`ref="Assets/Prefabs/Crystal.prefab"\` |
| \`ext:\` | File extension | \`ext:png\`, \`ext:cs\` |
| \`dir:\` | Directory scope | \`dir:Assets/Prefabs\` |
| \`name:\` | File name | \`name:laser\` |
| \`size\` | File size (bytes) | \`size>4096\`, \`size<=1024\` |
| \`age\` | Days since modified | \`age<3\`, \`age>30\` |
| \`a:\` | Area | \`a:assets\`, \`a:packages\`, \`a:all\` |
| \`prefab:\` | Prefab type | \`prefab:root\`, \`prefab:variant\`, \`prefab:model\`, \`prefab:modified\` |
| \`is:\` | State filter | \`is:subasset\` |
| \`missing:\` | Missing refs | \`missing:scripts\` |

## Comparison Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| \`:\` | Contains/partial | \`t:texture\` |
| \`=\` | Exact match | \`t=Texture2D\` |
| \`!=\` | Not equal | \`filtermode!=0\` |
| \`>\` | Greater than | \`size>4096\` |
| \`<\` | Less than | \`age<3\` |
| \`>=\` | Greater or equal | \`width>=4096\` |
| \`<=\` | Less or equal | \`bounciness<=0.5\` |

## Boolean Logic

| Syntax | Meaning | Example |
|--------|---------|---------|
| space | AND (implicit) | \`t:texture volume\` |
| \`or\` | OR | \`player or monster\` |
| \`-\` | Exclude | \`-t:scene\` |
| \`()\` | Grouping | \`t:prefab (enemy or ally)\` |
| \`!\` | Exact name match | \`!stone\` |

## Indexed Property Queries

When the project search index is built, serialized properties can be queried directly:
- Numeric: \`health=2\`, \`bounciness>0.1\`
- Boolean: \`generatePath=true\`
- String: \`trait:indestru\` (partial), \`trait="tough but fair"\` (exact)
- Color (hex): \`color:ADA\`, \`color=ADADAD\`
- Vector component: \`bounds.x>1\`, \`acceleration.z=2\`
- Object ref: \`sprite:CharacterBody\`
- Null check: \`property=none\`

## Query Flags

| Flag | Effect |
|------|--------|
| \`+noResultsLimit\` | Return all results (default cap ~2999) |
| \`+fuzzy\` | Fuzzy/approximate matching |

## Examples

- All prefabs: \`t:prefab\`
- Prefabs with "enemy" in name: \`t:prefab enemy\`
- Large textures: \`t:texture size>1048576\`
- Recently modified scripts: \`ext:cs age<7\`
- Prefab variants: \`prefab:variant\`
- Materials in specific folder: \`t:material dir:Assets/Art/Materials\`
- Assets referencing a specific prefab: \`ref="Assets/Prefabs/Player.prefab"\``;

  // Static resource: search syntax reference
  server.registerResource(
    "unity_asset_search_syntax",
    "unity://assets/search-syntax",
    {
      description: "Full Unity asset search query syntax reference — filter tokens, operators, boolean logic, property queries, and examples.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{
        uri: "unity://assets/search-syntax",
        mimeType: "text/markdown",
        text: SEARCH_SYNTAX_CONTENT,
      }],
    }),
  );

  server.tool(
    "unity_search_assets",
    `Search Unity project assets. Returns JSON array of {id, label, score}.
Common query syntax:
  - By name: "enemy", "player*"
  - By type: "t:prefab", "t:material", "t:texture", "t:scene"
  - By label: "l:mylabel"
  - By extension: "ext:png", "ext:cs"
  - By directory: "dir:Assets/Prefabs"
  - Combined: "t:prefab enemy" (AND), "player or monster" (OR)
  - Exclude: "-t:scene" (NOT)
  - Prefab variants: "prefab:variant", "prefab:model"
Read unity://assets/search-syntax resource for full syntax reference.`,
    {
      projectPath: z.string().describe("Unity project root path"),
      query: z.string().describe("Search query string (e.g. \"t:prefab enemy\", \"ext:cs age<7\")"),
      limit: z.number().optional().default(10).describe("Max results to return (default 10, max 500)"),
    },
    async ({ projectPath, query, limit }) => {
      const result = await searchAssets({
        projectPath,
        query,
        limit,
        logger: stderrLogger,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.results) }],
      };
    },
  );

  server.tool(
    "unity_logs",
    "Pull Unity Console log entries incrementally using a cursor. First call without cursor subscribes from now (returns current cursor, zero entries). Subsequent calls with cursor return new entries since that cursor. Pass cursor 0 to get buffered history.",
    {
      projectPath: z.string().describe("Unity project root path"),
      cursor: z.number().optional().describe("Resume from this cursor. Omit to subscribe from now. Pass 0 for history."),
      limit: z.number().optional().describe("Max entries to return (1-100, default 100)"),
      filter: z.enum(["Log", "Warning", "Error", "Exception"]).optional().describe("Filter by log type"),
      search: z.string().optional().describe("Text search within message and stackTrace"),
    },
    async ({ projectPath, cursor, limit, filter, search }) => {
      const result = await getLogs({ projectPath, cursor, limit, filter, search, logger: stderrLogger });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Log retrieval failed: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: result.formatted }],
      };
    },
  );

  server.tool(
    "unity_console",
    "Snapshot of recent Unity Console entries — returns the most recent entries, mirroring what's currently visible in the Unity Console window.",
    {
      projectPath: z.string().describe("Unity project root path"),
      limit: z.number().optional().describe("Max entries to return (1-100, default 100)"),
      filter: z.enum(["Log", "Warning", "Error", "Exception"]).optional().describe("Filter by log type"),
      search: z.string().optional().describe("Text search within message and stackTrace"),
    },
    async ({ projectPath, limit, filter, search }) => {
      const result = await getConsole({ projectPath, limit, filter, search, logger: stderrLogger });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Console retrieval failed: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: result.formatted }],
      };
    },
  );

  return server;
}

// When run directly, start with stdio transport
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === nodePath.resolve(process.argv[1]);
if (isMain) {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport);
}
