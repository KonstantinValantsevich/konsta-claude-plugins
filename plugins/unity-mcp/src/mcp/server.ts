import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recompile } from "../core/recompile.js";
import { getStatus } from "../core/status.js";
import { lint } from "../core/lint.js";
import { runTests } from "../core/test.js";
import { getTestResults } from "../core/test-results.js";
import { listTests } from "../core/list-tests.js";
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

  return server;
}

// When run directly, start with stdio transport
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === nodePath.resolve(process.argv[1]);
if (isMain) {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport);
}
