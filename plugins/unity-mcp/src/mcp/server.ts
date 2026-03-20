import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { detectProject } from "../core/detect.js";
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

let cachedProjectRoot: string | null = null;

export function createServer(): McpServer {
  const server = new McpServer({
    name: "unity-mcp",
    version: "1.0.0",
  });

  server.tool(
    "unity_detect_project",
    "Detect if a directory is inside a Unity project. Returns the project root path or null.",
    { cwd: z.string().describe("Directory to search from") },
    async ({ cwd }) => {
      const projectPath = detectProject(cwd);
      if (projectPath) cachedProjectRoot = projectPath;
      return {
        content: [{
          type: "text" as const,
          text: projectPath
            ? `Unity project found: ${projectPath}`
            : "Not inside a Unity project",
        }],
      };
    },
  );

  server.tool(
    "unity_recompile",
    "Trigger Unity recompilation. Detects C# changes, installs bridge, and orchestrates compilation.",
    { projectPath: z.string().optional().describe("Unity project root path (uses cached detection if omitted)") },
    async ({ projectPath }) => {
      const path = projectPath || cachedProjectRoot;
      if (!path) {
        return {
          content: [{ type: "text" as const, text: "No project path provided and none cached. Run unity_detect_project first." }],
          isError: true,
        };
      }

      const result = await recompile(path, stderrLogger);

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
    { projectPath: z.string().optional().describe("Unity project root path (uses cached detection if omitted)") },
    async ({ projectPath }) => {
      const path = projectPath || cachedProjectRoot;
      if (!path) {
        return {
          content: [{ type: "text" as const, text: "No project path provided and none cached. Run unity_detect_project first." }],
          isError: true,
        };
      }

      const status = await getStatus(path, stderrLogger);
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
    { projectPath: z.string().optional().describe("Unity project root path (uses cached detection if omitted)") },
    async ({ projectPath }) => {
      const path = projectPath || cachedProjectRoot;
      if (!path) {
        return {
          content: [{ type: "text" as const, text: "No project path provided and none cached. Run unity_detect_project first." }],
          isError: true,
        };
      }

      const result = await lint(path, stderrLogger);
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
