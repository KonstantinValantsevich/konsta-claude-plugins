# E2E MCP Bridge Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create end-to-end tests that exercise the full MCP → bridge → Unity Editor → C# handler chain using a real Unity project and editor instance.

**Architecture:** Global setup creates a Unity project, opens the editor, and writes shared state to a temp JSON file. Each test phase file spawns its own MCP client via `StdioClientTransport`, resets to a git baseline in `beforeAll`, and bootstraps the bridge via `unity_recompile`. Tests run sequentially with `bail: 1` — any failure stops the suite.

**Tech Stack:** TypeScript, vitest, `@modelcontextprotocol/sdk` (Client + StdioClientTransport), Unity Editor (non-batch), osascript

**Spec:** `docs/superpowers/specs/2026-03-25-e2e-mcp-bridge-tests-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| **New:** `plugins/unity-mcp/vitest.e2e.config.ts` | E2E vitest config: sequential, no parallelism, bail:1, long timeouts |
| **New:** `plugins/unity-mcp/__tests__/e2e/helpers/state.ts` | Read/write shared state JSON (`projectPath`, `unityVersion`, `unityPid`, `jbAvailable`) |
| **New:** `plugins/unity-mcp/__tests__/e2e/helpers/unity.ts` | Unity process management: find version, create project, open/close editor, wait for ready |
| **New:** `plugins/unity-mcp/__tests__/e2e/helpers/mcp-client.ts` | MCP SDK client wrapper: spawn server, connect, `callTool()` with auto-injected `projectPath` |
| **New:** `plugins/unity-mcp/__tests__/e2e/helpers/fixtures.ts` | C# source string generators for test fixtures |
| **New:** `plugins/unity-mcp/__tests__/e2e/global-setup.ts` | Find Unity, create project, git init+tag, open editor, wait for ready |
| **New:** `plugins/unity-mcp/__tests__/e2e/global-teardown.ts` | Close Unity, delete temp project |
| **New:** `plugins/unity-mcp/__tests__/e2e/01-bridge-lifecycle.test.ts` | Bridge install, status, version auto-update |
| **New:** `plugins/unity-mcp/__tests__/e2e/02-recompile.test.ts` | Skip, success, error, fix flows |
| **New:** `plugins/unity-mcp/__tests__/e2e/03-tests.test.ts` | List, run, filter, results, staleness |
| **New:** `plugins/unity-mcp/__tests__/e2e/04-lint.test.ts` | Format violations → lint cleanup |
| **New:** `plugins/unity-mcp/__tests__/e2e/05-status-errors.test.ts` | Diagnostics, invalid path handling |
| Modify: `plugins/unity-mcp/package.json` | Add `"test:e2e"` script |

---

### Task 1: Vitest E2E Configuration + npm Script

**Files:**
- Create: `plugins/unity-mcp/vitest.e2e.config.ts`
- Modify: `plugins/unity-mcp/package.json`

- [ ] **Step 1: Create `vitest.e2e.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["__tests__/e2e/**/*.test.ts"],
    globalSetup: [
      "__tests__/e2e/global-setup.ts",
      "__tests__/e2e/global-teardown.ts",
    ],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    sequence: { concurrent: false },
    fileParallelism: false,
    bail: 1,
    passWithNoTests: false,
  },
});
```

- [ ] **Step 2: Add `test:e2e` script to `package.json`**

Add to the `"scripts"` object:

```json
"test:e2e": "vitest run --config vitest.e2e.config.ts"
```

- [ ] **Step 3: Commit**

```bash
git add plugins/unity-mcp/vitest.e2e.config.ts plugins/unity-mcp/package.json
git commit -m "build: add E2E vitest config and test:e2e script" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Shared State Helper

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/helpers/state.ts`

- [ ] **Step 1: Create `state.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface E2EState {
  projectPath: string;
  unityVersion: string;
  unityPid: number;
  jbAvailable: boolean;
}

const STATE_FILE = path.join(os.tmpdir(), "unity-mcp-e2e-state.json");

export function writeState(state: E2EState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

export function readState(): E2EState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

export function cleanupState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/helpers/state.ts
git commit -m "test: add E2E shared state helper" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Unity Process Helper

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/helpers/unity.ts`

- [ ] **Step 1: Create `unity.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";

const UNITY_HUB_EDITOR_DIR = "/Applications/Unity/Hub/Editor";
const EDITOR_LOG_PATH = path.join(
  os.homedir(),
  "Library/Logs/Unity/Editor.log",
);

/**
 * Scan Unity Hub editor directory, return latest version string via semver sort.
 */
export function findLatestUnityVersion(): string {
  const entries = fs.readdirSync(UNITY_HUB_EDITOR_DIR);
  const versions = entries
    .filter((e) => /^\d+\.\d+\.\d+/.test(e))
    .sort((a, b) => {
      const pa = a.split(/[.\-f]/);
      const pb = b.split(/[.\-f]/);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = parseInt(pa[i] || "0", 10);
        const nb = parseInt(pb[i] || "0", 10);
        if (na !== nb) return na - nb;
      }
      return 0;
    });
  if (versions.length === 0) {
    throw new Error("No Unity versions found in " + UNITY_HUB_EDITOR_DIR);
  }
  return versions[versions.length - 1];
}

/** Full path to Unity.app for a version string. */
export function unityAppPath(version: string): string {
  return path.join(UNITY_HUB_EDITOR_DIR, version, "Unity.app");
}

/** Full path to Unity binary for a version string. */
export function unityBinaryPath(version: string): string {
  return path.join(unityAppPath(version), "Contents/MacOS/Unity");
}

/**
 * Create a new Unity project in batchmode. Blocks until Unity exits.
 */
export function createUnityProject(
  binaryPath: string,
  projectDir: string,
): void {
  execFileSync(binaryPath, ["-createProject", projectDir, "-quit", "-batchmode"], {
    timeout: 300_000,
    stdio: "ignore",
  });
}

/**
 * Open Unity Editor in non-batch mode for a project.
 */
export function openUnityEditor(appPath: string, projectDir: string): void {
  execSync(`open -a "${appPath}" --args -projectPath "${projectDir}"`, {
    timeout: 10_000,
  });
}

/**
 * Poll `ps aux` until a Unity process for the project path appears.
 * Returns the PID, or throws on timeout.
 */
export async function waitForUnityProcess(
  projectDir: string,
  timeoutMs: number = 120_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const output = execSync(
        `ps aux | grep '[U]nity' | grep "${projectDir}" | grep -v batchMode | awk '{print $2}' | head -1`,
        { encoding: "utf-8", timeout: 5_000 },
      ).trim();
      if (output) return parseInt(output, 10);
    } catch {
      // not found yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("Timed out waiting for Unity process");
}

/**
 * Poll Unity Editor.log for "Refresh completed" to confirm project is fully loaded.
 * Only checks lines written after `startTime` to avoid matching stale log entries.
 */
export async function waitForEditorLogRefresh(
  timeoutMs: number = 300_000,
  startTime?: Date,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startTs = startTime ?? new Date();

  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(EDITOR_LOG_PATH);
      // Only check if log was modified after our start time
      if (stat.mtime >= startTs) {
        const content = fs.readFileSync(EDITOR_LOG_PATH, "utf-8");
        if (content.includes("Refresh completed")) {
          return;
        }
      }
    } catch {
      // log file doesn't exist yet
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error("Timed out waiting for editor log 'Refresh completed'");
}

/**
 * Send Cmd+R via osascript to trigger Unity recompilation (same pattern as applescript.ts).
 */
export function triggerOsascriptRefresh(pid: number): void {
  execSync(
    `osascript -e '
      set previousApp to (path to frontmost application as text)
      tell application "System Events"
        set frontmost of (first process whose unix id is ${pid}) to true
      end tell
      delay 0.3
      tell application "System Events"
        keystroke "r" using command down
      end tell
      tell application previousApp to activate
    '`,
    { timeout: 10_000 },
  );
}

/**
 * Kill Unity process.
 */
export function closeUnity(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  // Wait for process to actually exit
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // check if alive
      execSync("sleep 1");
    } catch {
      return; // process is gone
    }
  }
}

/**
 * Check if `jb` CLI is available.
 */
export function isJbAvailable(): boolean {
  try {
    execSync("which jb", { encoding: "utf-8", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/helpers/unity.ts
git commit -m "test: add E2E Unity process management helper" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: MCP Client Helper

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/helpers/mcp-client.ts`

- [ ] **Step 1: Create `mcp-client.ts`**

The MCP SDK `Client` + `StdioClientTransport` pattern: spawn `node dist/server.mjs` as a child process, connect via stdio, provide a `callTool` wrapper that auto-injects `projectPath`.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const SERVER_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "dist",
  "server.mjs",
);

export interface McpTestClient {
  client: Client;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Spawn MCP server, connect via StdioClientTransport.
 * `callTool` auto-injects `projectPath` from the provided default.
 */
export async function createMcpClient(
  defaultProjectPath: string,
): Promise<McpTestClient> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
  });

  const client = new Client(
    { name: "e2e-test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  async function callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<string> {
    const mergedArgs = { projectPath: defaultProjectPath, ...args };
    const result = await client.callTool({ name, arguments: mergedArgs });

    // Extract text from MCP content array
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return text;
  }

  async function close(): Promise<void> {
    await client.close();
  }

  return { client, callTool, close };
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/helpers/mcp-client.ts
git commit -m "test: add E2E MCP client helper with auto-injected projectPath" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: C# Fixtures Helper

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/helpers/fixtures.ts`

- [ ] **Step 1: Create `fixtures.ts`**

Pure functions returning C# source strings. No I/O.

```typescript
/**
 * Valid MonoBehaviour script.
 */
export function simpleMonoBehaviour(className: string): string {
  return `using UnityEngine;

public class ${className} : MonoBehaviour
{
    void Start()
    {
        Debug.Log("${className} started");
    }
}
`;
}

/**
 * C# file with a syntax error (missing semicolon).
 */
export function compileErrorScript(): string {
  return `using UnityEngine;

public class BrokenScript : MonoBehaviour
{
    void Start()
    {
        Debug.Log("broken")
    }
}
`;
}

/**
 * EditMode test class with a passing [Test] method.
 * Optional [Category] attribute.
 */
export function passingEditModeTest(
  className: string,
  category?: string,
): string {
  const categoryAttr = category ? `\n    [NUnit.Framework.Category("${category}")]` : "";
  return `using NUnit.Framework;

public class ${className}
{
    [Test]${categoryAttr}
    public void PassingTest()
    {
        Assert.Pass();
    }
}
`;
}

/**
 * EditMode test class with a failing [Test] method.
 */
export function failingEditModeTest(className: string): string {
  return `using NUnit.Framework;

public class ${className}
{
    [Test]
    public void FailingTest()
    {
        Assert.Fail("intentional failure");
    }
}
`;
}

/**
 * Assembly definition JSON for EditMode tests.
 * Required for Unity to discover test classes.
 */
export function editModeTestAsmdef(): string {
  return JSON.stringify(
    {
      name: "Tests",
      rootNamespace: "",
      references: ["UnityEngine.TestRunner", "UnityEditor.TestRunner"],
      includePlatforms: ["Editor"],
      excludePlatforms: [],
      allowUnsafeCode: false,
      overrideReferences: true,
      precompiledReferences: ["nunit.framework.dll"],
      autoReferenced: false,
      defineConstraints: ["UNITY_INCLUDE_TESTS"],
      versionDefines: [],
      noEngineReferences: false,
    },
    null,
    2,
  );
}

/**
 * Badly formatted C# script that violates many DotSettings rules.
 * Used by Phase 04 (lint) to verify JetBrains cleanup.
 */
export function badlyFormattedScript(): string {
  return `using System;
using System.Collections.Generic;
using UnityEngine;
namespace  BadFormatting{
public class LintTest:MonoBehaviour{
  [SerializeField]  private  static readonly int BadField=42;
  [SerializeField] int anotherField = 10;
    static public void  BadMethod( string arg1,int arg2 ){
    if(arg1 == null)
      Debug.Log("no braces");
    for(int i=0;i<arg2;i++)
      Debug.Log(i);
    foreach(var item in new List<int>{1,2,3})
      Debug.Log(item);
    while(arg2>0)
      arg2--;
    var x = new Dictionary<string,int>(){{"a",1},{"b",2}};
    Debug.Log( $"test" ); Debug.Log("same line");
    }


public void AnotherMethod(){} public void ThirdMethod(){}
}
}
`;
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/helpers/fixtures.ts
git commit -m "test: add E2E C# fixture generators" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Global Setup

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/global-setup.ts`

- [ ] **Step 1: Create `global-setup.ts`**

This is a vitest `globalSetup` file — it exports a default function that runs once before all test files.

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  findLatestUnityVersion,
  unityBinaryPath,
  unityAppPath,
  createUnityProject,
  openUnityEditor,
  waitForUnityProcess,
  waitForEditorLogRefresh,
  isJbAvailable,
} from "./helpers/unity.js";
import { writeState } from "./helpers/state.js";

export default async function globalSetup(): Promise<void> {
  console.log("[E2E] Starting global setup...");

  // 1. Find Unity
  const version = findLatestUnityVersion();
  console.log(`[E2E] Found Unity version: ${version}`);

  // 2. Check jb
  const jbAvailable = isJbAvailable();
  console.log(`[E2E] jb CLI available: ${jbAvailable}`);

  // 3. Create temp project
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "unity-mcp-e2e-"),
  );
  console.log(`[E2E] Creating Unity project at: ${projectDir}`);
  createUnityProject(unityBinaryPath(version), projectDir);
  console.log("[E2E] Unity project created");

  // 4. Init git + tag baseline
  execSync("git init", { cwd: projectDir, stdio: "ignore" });
  execSync("git add -A", { cwd: projectDir, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: projectDir, stdio: "ignore" });
  execSync("git tag e2e-baseline", { cwd: projectDir, stdio: "ignore" });
  console.log("[E2E] Git initialized with e2e-baseline tag");

  // 5. Open editor (non-batch)
  const startTime = new Date();
  console.log("[E2E] Opening Unity Editor...");
  openUnityEditor(unityAppPath(version), projectDir);

  // 6. Wait for Unity process
  const pid = await waitForUnityProcess(projectDir);
  console.log(`[E2E] Unity process detected: PID ${pid}`);

  // 7. Wait for editor to finish loading
  console.log("[E2E] Waiting for editor 'Refresh completed'...");
  await waitForEditorLogRefresh(300_000, startTime);
  console.log("[E2E] Editor ready");

  // 8. Write shared state
  writeState({
    projectPath: projectDir,
    unityVersion: version,
    unityPid: pid,
    jbAvailable,
  });

  console.log("[E2E] Global setup complete");
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/global-setup.ts
git commit -m "test: add E2E global setup (Unity project creation + editor launch)" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Global Teardown

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/global-teardown.ts`

- [ ] **Step 1: Create `global-teardown.ts`**

```typescript
import fs from "node:fs";
import { readState, cleanupState } from "./helpers/state.js";
import { closeUnity } from "./helpers/unity.js";

export default async function globalTeardown(): Promise<void> {
  console.log("[E2E] Starting global teardown...");

  let state;
  try {
    state = readState();
  } catch {
    console.log("[E2E] No state file found, nothing to tear down");
    return;
  }

  // 1. Close Unity
  if (state.unityPid) {
    console.log(`[E2E] Closing Unity (PID ${state.unityPid})...`);
    closeUnity(state.unityPid);
    console.log("[E2E] Unity closed");
  }

  // 2. Delete temp project
  if (state.projectPath) {
    console.log(`[E2E] Deleting project: ${state.projectPath}`);
    fs.rmSync(state.projectPath, { recursive: true, force: true });
    console.log("[E2E] Project deleted");
  }

  // 3. Cleanup state file
  cleanupState();

  console.log("[E2E] Global teardown complete");
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/global-teardown.ts
git commit -m "test: add E2E global teardown (Unity close + cleanup)" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Phase 01 — Bridge Lifecycle Tests

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/01-bridge-lifecycle.test.ts`

This phase validates bridge installation, status reporting, and version auto-update. Each test within the file depends on state from the previous test (sequential, `bail: 1`).

- [ ] **Step 1: Create `01-bridge-lifecycle.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readState } from "./helpers/state.js";
import { createMcpClient, type McpTestClient } from "./helpers/mcp-client.js";
import { triggerOsascriptRefresh } from "./helpers/unity.js";
import {
  BRIDGE_EDITOR_DIR,
  BRIDGE_VERSION,
  BRIDGE_IPC_DIRNAME,
  BRIDGE_READY_FILENAME,
} from "../../src/lib/config.js";

let mcp: McpTestClient;
let projectPath: string;
let unityPid: number;

describe("Phase 01 — Bridge Lifecycle", () => {
  beforeAll(async () => {
    const state = readState();
    projectPath = state.projectPath;
    unityPid = state.unityPid;

    // Cross-phase isolation: reset to baseline
    execSync("git reset --hard e2e-baseline && git clean -fdx", {
      cwd: projectPath,
      stdio: "ignore",
    });

    // Create MCP client
    mcp = await createMcpClient(projectPath);

    // Bootstrap: reinstall bridge after git clean
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    await mcp.close();
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
    triggerOsascriptRefresh(unityPid);

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
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/01-bridge-lifecycle.test.ts
git commit -m "test: add E2E Phase 01 — bridge lifecycle tests" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: Phase 02 — Recompile Tests

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/02-recompile.test.ts`

- [ ] **Step 1: Create `02-recompile.test.ts`**

```typescript
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
    execSync("git reset --hard e2e-baseline && git clean -fdx", {
      cwd: projectPath,
      stdio: "ignore",
    });

    mcp = await createMcpClient(projectPath);

    // Bootstrap
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    await mcp.close();
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
    // Should contain file/line reference
    expect(text).toMatch(/BrokenScript\.cs/);
  });

  it("test 7: fix error → success", async () => {
    // Replace broken script with valid one
    const filePath = path.join(projectPath, "Assets", "BrokenScript.cs");
    fs.writeFileSync(filePath, simpleMonoBehaviour("BrokenScript"));

    const text = await mcp.callTool("unity_recompile");
    expect(text.toLowerCase()).toContain("success");
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/02-recompile.test.ts
git commit -m "test: add E2E Phase 02 — recompile tests" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: Phase 03 — Tests Phase

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/03-tests.test.ts`

This is the largest phase — 10 tests covering list, run, filter, results, and staleness. Each test depends on the state from the previous.

- [ ] **Step 1: Create `03-tests.test.ts`**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/03-tests.test.ts
git commit -m "test: add E2E Phase 03 — test runner tests (list, run, filter, results, stale)" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 11: Phase 04 — Lint Tests

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/04-lint.test.ts`

- [ ] **Step 1: Create `04-lint.test.ts`**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/04-lint.test.ts
git commit -m "test: add E2E Phase 04 — lint tests" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 12: Phase 05 — Status & Errors Tests

**Files:**
- Create: `plugins/unity-mcp/__tests__/e2e/05-status-errors.test.ts`

- [ ] **Step 1: Create `05-status-errors.test.ts`**

```typescript
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
    execSync("git reset --hard e2e-baseline && git clean -fdx", {
      cwd: projectPath,
      stdio: "ignore",
    });

    mcp = await createMcpClient(projectPath);

    // Bootstrap
    await mcp.callTool("unity_recompile");
  }, 600_000);

  afterAll(async () => {
    await mcp.close();
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
```

- [ ] **Step 2: Commit**

```bash
git add plugins/unity-mcp/__tests__/e2e/05-status-errors.test.ts
git commit -m "test: add E2E Phase 05 — status and error handling tests" -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 13: Final Review & Integration Verification

- [ ] **Step 1: Verify all files exist**

Run:
```bash
ls -la plugins/unity-mcp/__tests__/e2e/ plugins/unity-mcp/__tests__/e2e/helpers/ plugins/unity-mcp/vitest.e2e.config.ts
```

Expected: All 12 files present.

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
npx --prefix plugins/unity-mcp tsc --noEmit --project plugins/unity-mcp/tsconfig.json 2>&1 || echo "Note: tsconfig may need E2E includes"
```

If there's a tsconfig issue (e.g., test files not included), this may need adjustment — but vitest handles its own compilation via tsx, so this is informational only.

- [ ] **Step 3: Verify the test:e2e script is registered**

Run:
```bash
npm --prefix plugins/unity-mcp run test:e2e -- --help 2>&1 | head -5
```

Expected: vitest help output (confirms the script resolves).

- [ ] **Step 4: Verify existing unit tests still pass**

Run:
```bash
npx --prefix plugins/unity-mcp vitest run
```

Expected: All existing tests pass (E2E tests are in a separate config and won't be picked up).

- [ ] **Step 5: Commit any fixups**

Only if steps 2-4 required changes.
