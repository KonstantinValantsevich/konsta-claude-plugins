/**
 * E2E tests against a real Unity project (solitaire).
 *
 * Prerequisites:
 *   - Unity editor open with the solitaire project
 *   - Bridge ready (bridge-ready.json present in Library/ClaudeHookIPC/)
 *
 * Run: npx --prefix plugins/unity-mcp vitest run __tests__/e2e/live-mcp.test.ts
 */
import fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../../src/mcp/server.js";

const PROJECT_PATH = "/Users/konsta/Documents/Work_Projects/solitaire";
const BOGUS_PROJECT = "/tmp/not-a-unity-project";
const CS_FILE = `${PROJECT_PATH}/Assets/Solitaire/Scripts/Logic/Common/Card.cs`;

// MCP SDK default is 60s — bridge operations need much longer
const LONG_TIMEOUT = 360_000;

let client: Client;
let server: McpServer;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: LONG_TIMEOUT },
  );
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, isError: result.isError ?? false };
}

function touchFile(filePath: string) {
  const now = new Date();
  fs.utimesSync(filePath, now, now);
}

describe("E2E: live MCP against solitaire", () => {
  beforeAll(async () => {
    server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  // ── unity_status ──────────────────────────────────────────────

  describe("unity_status", () => {
    it("returns correct Unity version and project path", async () => {
      const { text } = await callTool("unity_status", {
        projectPath: PROJECT_PATH,
      });
      expect(text).toContain("Unity Version: 6000.3.0f1");
      expect(text).toContain(`Unity Project: ${PROJECT_PATH}`);
    });

    it("reports editor running with PID", async () => {
      const { text } = await callTool("unity_status", {
        projectPath: PROJECT_PATH,
      });
      expect(text).toMatch(/Editor Running: Yes \(PID \d+\)/);
    });

    it("reports bridge ready with version info", async () => {
      const { text } = await callTool("unity_status", {
        projectPath: PROJECT_PATH,
      });
      expect(text).toMatch(/Bridge Ready: Yes \(bridge v\d+, protocol v\d+\)/);
    });

    it("reports last recompile timestamp", async () => {
      const { text } = await callTool("unity_status", {
        projectPath: PROJECT_PATH,
      });
      expect(text).toMatch(/Last Recompile: \d{4}-\d{2}-\d{2}T/);
    });

    it("handles bogus project path gracefully", async () => {
      const { text } = await callTool("unity_status", {
        projectPath: BOGUS_PROJECT,
      });
      expect(text).toContain("Unity Version: Unknown");
      expect(text).toContain("Editor Running: No");
      expect(text).toContain("Bridge Ready: No");
    });
  });

  // ── unity_recompile ───────────────────────────────────────────

  describe("unity_recompile", () => {
    it("succeeds on first call (compile or skip)", async () => {
      const { text, isError } = await callTool("unity_recompile", {
        projectPath: PROJECT_PATH,
      });
      expect(isError).toBe(false);
      expect(text).toMatch(/skipped|successfully/);
    }, LONG_TIMEOUT);

    it("skips when called immediately again (no changes)", async () => {
      const { text, isError } = await callTool("unity_recompile", {
        projectPath: PROJECT_PATH,
      });
      expect(isError).toBe(false);
      expect(text).toContain("skipped");
    });

    it("detects changes and recompiles after touching a .cs file", async () => {
      touchFile(CS_FILE);

      const { text, isError } = await callTool("unity_recompile", {
        projectPath: PROJECT_PATH,
      });
      expect(isError).toBe(false);
      expect(text).toContain("successfully");
    }, LONG_TIMEOUT);

    it("skips again after successful recompile", async () => {
      const { text } = await callTool("unity_recompile", {
        projectPath: PROJECT_PATH,
      });
      expect(text).toContain("skipped");
    });

    it("skips for bogus project path (no .cs files)", async () => {
      const { text, isError } = await callTool("unity_recompile", {
        projectPath: BOGUS_PROJECT,
      });
      expect(isError).toBe(false);
      expect(text).toContain("skipped");
    });
  });

  // ── unity_lint ────────────────────────────────────────────────

  describe("unity_lint", () => {
    // Temp file with intentional style violations for lint to fix
    const LINT_FILE = `${PROJECT_PATH}/Assets/Solitaire/Scripts/LintTestTemp.cs`;
    const UGLY_CS = [
      "using System;",
      "using System.Collections.Generic;",
      "",
      "namespace Solitaire.LintTest",
      "{",
      "    public class LintTestTemp",
      "    {",
      '        private string   _foo= "bar" ;',           // extra spaces, missing space before =
      "        public void DoStuff( ){",                    // space inside parens
      "            var x=1;",                               // no spaces around =
      '            var y  =   new   List<string>( ) ;',    // excessive spacing
      "            if(x==1)",                               // no space after if
      "                Console.WriteLine(_foo);",           // braceless if body
      "            for(var i=0;i<x;i++)",                   // braceless for, missing spaces
      "                Console.WriteLine(i);",
      "            while(x>0)",                             // braceless while
      "                x--;",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");

    afterAll(() => {
      // Always clean up: remove file, unstage from git index
      try { fs.unlinkSync(LINT_FILE); } catch {}
      try { fs.unlinkSync(LINT_FILE + ".meta"); } catch {}
      try {
        const { execSync } = require("node:child_process");
        execSync(`git -C "${PROJECT_PATH}" rm --cached --force "${LINT_FILE}" 2>/dev/null || true`);
        execSync(`git -C "${PROJECT_PATH}" rm --cached --force "${LINT_FILE}.meta" 2>/dev/null || true`);
      } catch {}
    });

    it("lints a file with style violations", async () => {
      // 1. Create ugly temp file and stage it so git diff HEAD sees it
      fs.writeFileSync(LINT_FILE, UGLY_CS);
      const { execSync } = require("node:child_process");
      execSync(`git -C "${PROJECT_PATH}" add "${LINT_FILE}"`);

      // 2. Run lint
      const { text, isError } = await callTool("unity_lint", {
        projectPath: PROJECT_PATH,
      });
      expect(isError).toBeFalsy();
      expect(text).toMatch(/Linted 1 file/);

      // 3. Verify jb actually fixed the violations
      const after = fs.readFileSync(LINT_FILE, "utf-8");
      expect(after).not.toBe(UGLY_CS);

      // Spacing fixes
      expect(after).toContain('_foo = "bar"');   // spaces around =
      expect(after).toContain("var x = 1;");     // spaces around =
      expect(after).toMatch(/if \(/);            // space after if
      expect(after).toMatch(/for \(/);           // space after for
      expect(after).toMatch(/while \(/);         // space after while
      expect(after).toContain("DoStuff()");      // no space inside parens

      // Braces added to single-line if/for/while bodies
      // Ugly file has braceless: if(...)  Console..., for(...)  Console..., while(...)  x--
      // After cleanup each should have { } wrapping the body
      expect(after).toMatch(/if\s*\([^)]+\)\s*\{/);    // if (...) {
      expect(after).toMatch(/for\s*\([^)]+\)\s*\{/);   // for (...) {
      expect(after).toMatch(/while\s*\([^)]+\)\s*\{/); // while (...) {
    }, 130_000);

    it("runs without error when no files changed", async () => {
      const { text, isError } = await callTool("unity_lint", {
        projectPath: PROJECT_PATH,
      });
      expect(isError).toBeFalsy();
      expect(text).toMatch(/Linted|No changed/);
    }, 130_000);

    it("reports no files for bogus project path", async () => {
      const { text, isError } = await callTool("unity_lint", {
        projectPath: BOGUS_PROJECT,
      });
      expect(isError).toBeFalsy();
      expect(text).toContain("No changed");
    });
  });

  // ── unity_run_tests ───────────────────────────────────────────

  describe("unity_run_tests", () => {
    // Use groupNames filter to run only Sweepstakes tests (~52 tests, fast)
    const SWEEPSTAKES_FILTER = ["UnitTestsForSweepstakes"];
    let lastRunId: string;

    it("runs filtered tests and returns results", async () => {
      const { text, isError } = await callTool("unity_run_tests", {
        projectPath: PROJECT_PATH,
        groupNames: SWEEPSTAKES_FILTER,
      });
      expect(isError).toBe(false);
      expect(text).toMatch(/Pass:\s+\d+/);
      expect(text).toMatch(/Fail:\s+\d+/);

      const match = text.match(/Run (test-\d+)/);
      expect(match).toBeTruthy();
      lastRunId = match![1];
    }, LONG_TIMEOUT);

    it("verbose mode shows [PASS]/[FAIL] markers per test", async () => {
      const { text, isError } = await callTool("unity_run_tests", {
        projectPath: PROJECT_PATH,
        groupNames: SWEEPSTAKES_FILTER,
        verbose: true,
      });
      expect(isError).toBe(false);
      expect(text).toMatch(/\[(PASS|FAIL|SKIP)\]/);
      // All tests should be from the filtered class
      const testLines = text
        .split("\n")
        .filter((l) => /\[(PASS|FAIL|SKIP)\]/.test(l));
      expect(testLines.length).toBeGreaterThan(0);
      for (const line of testLines) {
        expect(line).toContain("UnitTestsForSweepstakes");
      }
    }, LONG_TIMEOUT);

    it("bogus project returns error (editor not running)", async () => {
      const { text, isError } = await callTool("unity_run_tests", {
        projectPath: BOGUS_PROJECT,
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/Unity editor must be running|Bridge is not ready/);
    });

    // ── unity_test_results (depends on run_tests above) ─────────

    describe("unity_test_results", () => {
      it("retrieves latest run with summary", async () => {
        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
        });
        expect(text).toMatch(/Run test-\d+/);
        expect(text).toMatch(/Pass:\s+\d+/);
      });

      it("retrieves a specific run by ID", async () => {
        expect(lastRunId).toBeTruthy();
        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
          runId: lastRunId,
        });
        expect(text).toContain(lastRunId);
        expect(text).toMatch(/Pass:\s+\d+/);
      });

      it("verbose mode lists individual test entries", async () => {
        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
          verbose: true,
        });
        expect(text).toMatch(/\[(PASS|FAIL|SKIP)\]/);
      });

      it("statusFilter: passed excludes failures", async () => {
        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
          statusFilter: "passed",
          verbose: true,
        });
        if (text.includes("[PASS]")) {
          expect(text).not.toContain("[FAIL]");
          expect(text).not.toContain("[SKIP]");
        }
      });

      it("statusFilter: failed excludes passes", async () => {
        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
          statusFilter: "failed",
          verbose: true,
        });
        if (text.includes("[FAIL]")) {
          expect(text).not.toContain("[PASS]");
          expect(text).not.toContain("[SKIP]");
        }
      });

      it("nameFilter narrows results by regex", async () => {
        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
          nameFilter: ".*IconState.*",
          verbose: true,
        });
        const testLines = text
          .split("\n")
          .filter((l) => /\[(PASS|FAIL|SKIP)\]/.test(l));
        for (const line of testLines) {
          expect(line).toMatch(/IconState/i);
        }
      });

      it("bogus runId returns not found", async () => {
        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
          runId: "test-0000000000000",
        });
        expect(text).toContain("No test run found");
      });

      it("detects staleness after code changes", async () => {
        touchFile(CS_FILE);

        const { text } = await callTool("unity_test_results", {
          projectPath: PROJECT_PATH,
        });
        expect(text).toMatch(/stale/i);
      });
    });
  });
});
