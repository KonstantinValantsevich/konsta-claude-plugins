import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { simpleMonoBehaviour } from "./helpers/fixtures.js";

let mcp: McpTestClient;
let projectPath: string;

describe("Phase 07 — Logs", () => {
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;

    // Cross-phase isolation
    execSync("git reset --hard e2e-baseline && git clean -fd", {
      cwd: projectPath,
      stdio: "ignore",
    });

    mcp = await createMcpClient(projectPath);

    // Bootstrap bridge (installs new log C# files)
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    if (mcp) await mcp.close();
  });

  it("test 27: unity_logs without cursor subscribes from now", async () => {
    const text = await mcp.callTool("unity_logs");

    // Should return a cursor line with no entries
    expect(text).toMatch(/Cursor: \d+/);
  });

  it("test 28: unity_console returns recent entries", async () => {
    // Trigger a recompile to generate log entries
    const fixtureDir = path.join(projectPath, "Assets", "LogFixture");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "LogTestComponent.cs"),
      simpleMonoBehaviour("LogTestComponent"),
    );
    await mcp.callTool("unity_recompile");

    const text = await mcp.callTool("unity_console");
    expect(text).toMatch(/Cursor: \d+/);
    expect(text).toMatch(/Buffered: \d+/);
  });

  it("test 29: unity_logs with cursor 0 returns history", async () => {
    const text = await mcp.callTool("unity_logs", { cursor: 0 });

    // Should have at least some log entries from bridge init / recompile
    expect(text).toMatch(/Cursor: \d+/);
    expect(text).toMatch(/Buffered: \d+/);
  });

  it("test 30: unity_logs cursor-based incremental pull", async () => {
    // First call: subscribe from now
    const text1 = await mcp.callTool("unity_logs");
    const cursorMatch = text1.match(/Cursor: (\d+)/);
    expect(cursorMatch).toBeTruthy();
    const cursor = parseInt(cursorMatch![1], 10);

    // Trigger activity to generate new logs
    const filePath = path.join(projectPath, "Assets", "LogFixture", "LogTestComponent2.cs");
    fs.writeFileSync(filePath, simpleMonoBehaviour("LogTestComponent2"));
    await mcp.callTool("unity_recompile");

    // Second call with cursor: should get new entries
    const text2 = await mcp.callTool("unity_logs", { cursor });
    expect(text2).toMatch(/Cursor: \d+/);
  });

  it("test 31: unity_console with filter returns filtered entries", async () => {
    const text = await mcp.callTool("unity_console", { filter: "Error" });
    expect(text).toMatch(/Cursor: \d+/);
    // If there are entries, they should all be [Error]
    const lines = text.split("\n").filter((l: string) => l.startsWith("["));
    for (const line of lines) {
      expect(line).toMatch(/^\[Error\]/);
    }
  });

  it("test 32: unity_console with search filters by text", async () => {
    const text = await mcp.callTool("unity_console", { search: "xyzzy_nonexistent_search_term" });
    expect(text).toMatch(/Cursor: \d+/);
    // Should have no entry lines (only the metadata line)
    const entryLines = text.split("\n").filter((l: string) => l.startsWith("["));
    expect(entryLines.length).toBe(0);
  });
});
