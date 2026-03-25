import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import {
  simpleMonoBehaviour,
  badlyFormattedScript,
} from "./helpers/fixtures.js";

// Read state at module level — describe.skipIf evaluates at parse time
const state = readState();
const jbAvailable = state.jbAvailable;

let mcp: McpTestClient;
let projectPath: string;

describe("Phase 04 — Lint", () => {
  beforeAll(async () => {
    projectPath = state.projectPath;

    if (!jbAvailable) return;

    // Cross-phase isolation
    execSync("git reset --hard e2e-baseline && git clean -fdx", {
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

  describe.skipIf(!jbAvailable)("jb available", () => {
    it("test 18: lint formats changed file", async () => {
      const filePath = path.join(projectPath, "Assets", "LintTest.cs");

      // First: write well-formatted version, commit it
      fs.writeFileSync(filePath, simpleMonoBehaviour("LintTest"));
      execSync("git add -A && git commit -m 'add LintTest'", {
        cwd: projectPath,
        stdio: "ignore",
      });

      // Overwrite with badly formatted version (uncommitted change)
      const badCode = badlyFormattedScript();
      fs.writeFileSync(filePath, badCode);

      // Run lint
      const text = await mcp.callTool("unity_lint");
      expect(text).toMatch(/linted \d+ file/i);

      // Read the file after lint and verify improvements
      const after = fs.readFileSync(filePath, "utf-8");

      // Braces added to if/for/foreach/while
      expect(after).not.toMatch(/if\s*\([^)]+\)\s*\n\s*[^{]/);

      // Modifier order corrected: "static public" → "public static"
      expect(after).not.toContain("static public");

      // No multiple statements on one line (the "Debug.Log...Debug.Log" line)
      const lines = after.split("\n");
      const multiStatement = lines.some(
        (l) => (l.match(/Debug\.Log/g) || []).length > 1,
      );
      expect(multiStatement).toBe(false);
    });
  });
});
