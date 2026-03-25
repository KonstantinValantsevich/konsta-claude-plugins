import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import {
  simpleMonoBehaviour,
  compileErrorScript,
} from "./helpers/fixtures.js";

let mcp: McpTestClient;
let projectPath: string;

describe("Phase 02 — Recompile", () => {
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

  it("test 4: no changes → skip", async () => {
    // Second recompile with no new files
    const text = await mcp.callTool("unity_recompile");
    expect(text.toLowerCase()).toContain("skip");
  });

  it("test 5: valid C# file → success", async () => {
    const filePath = path.join(projectPath, "Assets", "SimpleComponent.cs");
    fs.writeFileSync(filePath, simpleMonoBehaviour("SimpleComponent"));

    const text = await mcp.callTool("unity_recompile");
    expect(text.toLowerCase()).toContain("success");
  });

  it("test 6: compile error → reports errors", async () => {
    const filePath = path.join(projectPath, "Assets", "BrokenScript.cs");
    fs.writeFileSync(filePath, compileErrorScript());

    const text = await mcp.callTool("unity_recompile");
    expect(text.toLowerCase()).toContain("fail");
  });

  it("test 7: fix error → success", async () => {
    // Replace broken script with valid one
    const filePath = path.join(projectPath, "Assets", "BrokenScript.cs");
    fs.writeFileSync(filePath, simpleMonoBehaviour("BrokenScript"));

    const text = await mcp.callTool("unity_recompile");
    expect(text.toLowerCase()).toContain("success");
  });
});
