import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { triggerOsascriptRefresh } from "./helpers/unity.js";
import { findUnityPid } from "../../src/lib/compile/applescript.js";
import {
  BRIDGE_EDITOR_DIR,
  BRIDGE_VERSION,
  BRIDGE_IPC_DIRNAME,
  BRIDGE_READY_FILENAME,
} from "../../src/lib/config.js";

let mcp: McpTestClient;
let projectPath: string;

describe("Phase 01 — Bridge Lifecycle", () => {
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;

    // Cross-phase isolation: reset to baseline
    execSync("git reset --hard e2e-baseline && git clean -fd -- Assets/", {
      cwd: projectPath,
      stdio: "ignore",
    });

    // Create MCP client
    mcp = await createMcpClient(projectPath);

    // First tool call: auto-launches Unity + installs bridge + recompiles
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    if (mcp) await mcp.close();
  });

  it("test 1: first tool call installs bridge", async () => {
    const bridgeDir = path.join(projectPath, BRIDGE_EDITOR_DIR);
    expect(fs.existsSync(bridgeDir)).toBe(true);

    const files = fs.readdirSync(bridgeDir);
    expect(files).toContain("ClaudeBridgeBase.cs");
    expect(files).toContain("ClaudeRecompileHandler.cs");
    expect(files).toContain("ClaudeTestHandler.cs");
  });

  it("test 2: status shows bridge ready", async () => {
    const text = await mcp.callTool("unity_status");

    expect(text).toContain("Editor Running: Yes");
    expect(text).toContain("Bridge Ready: Yes");
    expect(text).toMatch(/Unity Version: \d+\.\d+/);
    expect(text).toMatch(/bridge v\d+/);
  });

  it("test 3: bridge version auto-update", async () => {
    // Overwrite bridge .cs files with a lower version string
    const bridgeDir = path.join(projectPath, BRIDGE_EDITOR_DIR);
    const basePath = path.join(bridgeDir, "ClaudeBridgeBase.cs");
    let baseContent = fs.readFileSync(basePath, "utf-8");
    // Replace bridge version constant with a stale value
    baseContent = baseContent.replace(
      /BridgeVersion\s*=\s*"[^"]*"/,
      'BridgeVersion = "0"',
    );
    fs.writeFileSync(basePath, baseContent);

    // Trigger Cmd+R so Unity recompiles the stale bridge
    const pid = findUnityPid(projectPath);
    expect(pid).not.toBeNull();
    triggerOsascriptRefresh(parseInt(pid!, 10));

    // Wait for bridge-ready.json to appear with stale version
    const readyFile = path.join(
      projectPath,
      BRIDGE_IPC_DIRNAME,
      BRIDGE_READY_FILENAME,
    );
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const ready = JSON.parse(fs.readFileSync(readyFile, "utf-8"));
        if (ready.bridgeVersion === "0") break;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }

    // Call a tool — sendBridgeRequest should detect mismatch, reinstall, bootstrap
    const text = await mcp.callTool("unity_list_tests");

    // Verify bridge files are restored to correct version
    const restored = fs.readFileSync(basePath, "utf-8");
    expect(restored).toContain(`BridgeVersion = "${BRIDGE_VERSION}"`);

    // The tool call should have succeeded (bridge auto-updated)
    expect(text).toBeDefined();
  }, 300_000);
});
