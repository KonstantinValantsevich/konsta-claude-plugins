import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recompile } from "../core/recompile.js";
import { getStatus } from "../core/status.js";
import { lint } from "../core/lint.js";
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
      const result = await lint(projectPath, stderrLogger);
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

  return server;
}

// When run directly, start with stdio transport
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === nodePath.resolve(process.argv[1]);
if (isMain) {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport);
}
