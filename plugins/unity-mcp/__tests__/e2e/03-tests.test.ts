import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import {
  passingEditModeTest,
  failingEditModeTest,
  editModeTestAsmdef,
  simpleMonoBehaviour,
} from "./helpers/fixtures.js";

let mcp: McpTestClient;
let projectPath: string;
let lastRunId: string;

describe("Phase 03 — Tests", () => {
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;

    // Cross-phase isolation
    execSync("git reset --hard e2e-baseline && git clean -fdx", {
      cwd: projectPath,
      stdio: "ignore",
    });

    mcp = await createMcpClient(projectPath);

    // Bootstrap
    await mcp.callTool("unity_recompile");

    // Create EditMode test folder structure with .asmdef
    const testDir = path.join(projectPath, "Assets", "Tests", "Editor");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      path.join(testDir, "Tests.asmdef"),
      editModeTestAsmdef(),
    );
  }, 600_000);

  afterAll(async () => {
    await mcp.close();
  });

  it("test 8: list tests — empty", async () => {
    const text = await mcp.callTool("unity_list_tests");
    // No test classes exist yet — expect empty or "0 tests"
    expect(text).toMatch(/0 test/i);
  });

  it("test 9: add passing test → list finds it", async () => {
    const testDir = path.join(projectPath, "Assets", "Tests", "Editor");
    fs.writeFileSync(
      path.join(testDir, "SampleTest.cs"),
      passingEditModeTest("SampleTest"),
    );

    // Recompile so Unity discovers the new test
    await mcp.callTool("unity_recompile");

    const text = await mcp.callTool("unity_list_tests");
    expect(text).toContain("SampleTest");
    expect(text).toContain("PassingTest");
  });

  it("test 10: run tests → pass", async () => {
    const text = await mcp.callTool("unity_run_tests");
    expect(text).toMatch(/pass/i);
    expect(text).toMatch(/fail.*0|failCount.*0/i);

    // Extract run ID for later
    const match = text.match(/run[_\s-]*id[:\s]*(\S+)/i) ?? text.match(/(test-\d+)/);
    if (match) lastRunId = match[1];
  });

  it("test 11: run tests verbose mode", async () => {
    const text = await mcp.callTool("unity_run_tests", { verbose: true });
    expect(text).toContain("SampleTest");
    expect(text).toContain("PassingTest");
    // Verbose should include more detail than summary
    expect(text.length).toBeGreaterThan(50);
  });

  it("test 12: add failing test → failure reported", async () => {
    const testDir = path.join(projectPath, "Assets", "Tests", "Editor");
    fs.writeFileSync(
      path.join(testDir, "FailTest.cs"),
      failingEditModeTest("FailTest"),
    );

    // run_tests calls recompile internally
    const text = await mcp.callTool("unity_run_tests");
    expect(text).toMatch(/fail/i);
    expect(text).toContain("intentional failure");
  });

  it("test 13: filter by category", async () => {
    const testDir = path.join(projectPath, "Assets", "Tests", "Editor");
    fs.writeFileSync(
      path.join(testDir, "SlowTest.cs"),
      passingEditModeTest("SlowTest", "Slow"),
    );

    const text = await mcp.callTool("unity_run_tests", {
      categoryNames: ["Slow"],
    });
    expect(text).toContain("SlowTest");
    // Should not run the failing test (different category)
    expect(text).not.toContain("intentional failure");
  });

  it("test 14: retrieve previous results", async () => {
    const text = await mcp.callTool("unity_test_results");
    // Should return results from last run
    expect(text).toContain("SlowTest");
  });

  it("test 15: filter results by status", async () => {
    // Run all tests first to get mix of pass/fail
    await mcp.callTool("unity_run_tests");

    const text = await mcp.callTool("unity_test_results", {
      statusFilter: "failed",
    });
    expect(text).toContain("FailTest");
    // Should not show passing tests
    expect(text).not.toContain("SlowTest");
  });

  it("test 16: filter results by name", async () => {
    const text = await mcp.callTool("unity_test_results", {
      nameFilter: "Sample",
    });
    expect(text).toContain("SampleTest");
    expect(text).not.toContain("FailTest");
  });

  it("test 17: stale results detection", async () => {
    // Wait for filesystem mtime resolution
    await new Promise((r) => setTimeout(r, 1_100));

    // Write a new C# file to trigger staleness
    fs.writeFileSync(
      path.join(projectPath, "Assets", "NewFile.cs"),
      simpleMonoBehaviour("NewFile"),
    );

    const text = await mcp.callTool("unity_test_results");
    expect(text.toLowerCase()).toContain("stale");
  });
});
