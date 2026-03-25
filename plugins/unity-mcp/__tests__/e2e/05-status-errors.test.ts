import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";

let mcp: McpTestClient;
let projectPath: string;

describe("Phase 05 — Status & Errors", () => {
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;

    // Cross-phase isolation
    execSync("git reset --hard e2e-baseline && git clean -fd", {
      cwd: projectPath,
      stdio: "ignore",
    });

    mcp = await createMcpClient(projectPath);

    // Bootstrap
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    if (mcp) await mcp.close();
  });

  it("test 19: status reports full diagnostics", async () => {
    const text = await mcp.callTool("unity_status");

    expect(text).toContain("Editor Running: Yes");
    expect(text).toContain("Bridge Ready: Yes");
    expect(text).toMatch(/Unity Version: \d+\.\d+/);
    expect(text).toMatch(/bridge v\d+/);
    expect(text).toMatch(/Last Recompile:/);
    // Last recompile should not be "Never" since bootstrap ran
    expect(text).not.toContain("Last Recompile: Never");
  });

  it("test 20: invalid project path", async () => {
    const text = await mcp.callTool("unity_recompile", {
      projectPath: "/tmp/nonexistent-unity-project-e2e",
    });

    // Should return error, not crash
    expect(text.toLowerCase()).toMatch(/error|not running|fail/);
  });
});
