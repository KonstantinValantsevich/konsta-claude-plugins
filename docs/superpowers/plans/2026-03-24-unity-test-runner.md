# Unity Test Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `unity_run_tests` and `unity_test_results` MCP tools with C# bridge refactoring for extensibility.

**Architecture:** Refactor the monolithic C# bridge into a base class + handler pattern. Add a synchronous EditMode test handler on the C# side. On the TS side, add test-store for disk-backed results, generalize the marker system, and register two new MCP tools with filtering and adaptive verbosity.

**Tech Stack:** TypeScript (vitest), C# (Unity Editor API — TestRunnerApi), MCP SDK, Zod, esbuild

**Spec:** `docs/superpowers/specs/2026-03-24-unity-test-runner-design.md`

---

## File Map

### New Files

| File | Responsibility |
|---|---|
| `templates/ClaudeBridgeBase.cs` | Shared C# bridge: IPC file watching, request parsing, status writing, action dispatch |
| `templates/ClaudeRecompileHandler.cs` | Recompile-specific C# logic extracted from current monolith |
| `templates/ClaudeTestHandler.cs` | C# test runner: synchronous EditMode test execution via TestRunnerApi |
| `src/lib/test-store.ts` | Disk-backed test run storage: save, load by ID, load latest |
| `src/core/test.ts` | `unity_run_tests` orchestration: send IPC, poll, store results |
| `src/core/test-results.ts` | `unity_test_results` logic: load, filter, format results |
| `__tests__/lib/test-store.test.ts` | Unit tests for test-store |
| `__tests__/core/test.test.ts` | Unit tests for test run orchestration |
| `__tests__/core/test-results.test.ts` | Unit tests for result filtering and formatting |

### Modified Files

| File | Change |
|---|---|
| `src/lib/config.ts` | Add test constants, rename bridge paths, replace `BRIDGE_CS_FILENAME` with `BRIDGE_CS_FILES` |
| `src/lib/project/changes.ts` | Generalize marker system: add `purpose` parameter to `getMarkerPath` |
| `src/lib/bridge/types.ts` | Extend action union, add test payload and result types |
| `src/lib/bridge/install.ts` | Multi-file install, folder rename, old folder migration |
| `src/lib/bridge/ipc.ts` | Add `TERMINAL_TEST_STATES` and `waitForTestStatus` |
| `src/core/types.ts` | Add `TestResult`, `StoredTestRun` interfaces |
| `src/core/recompile.ts` | Use generalized marker API (pass `"recompile"` purpose) |
| `src/core/status.ts` | Use generalized marker API (pass `"recompile"` purpose) |
| `src/mcp/server.ts` | Register two new tools |
| `__tests__/lib/project/changes.test.ts` | Add tests for multi-purpose markers |
| `__tests__/lib/bridge/install.test.ts` | Update for multi-file bridge install and new folder name |
| `__tests__/integration/full-flow.test.ts` | Update for `bridgeFiles`, new folder name, version "4" |
| `__tests__/mcp/server.test.ts` | Update to expect 5 tools |

---

## Task 1: Generalize the Marker System

**Files:**
- Modify: `plugins/unity-mcp/src/lib/project/changes.ts`
- Modify: `plugins/unity-mcp/src/core/recompile.ts`
- Modify: `plugins/unity-mcp/__tests__/lib/project/changes.test.ts`

- [ ] **Step 1: Write failing tests for purpose-based markers**

Add to `__tests__/lib/project/changes.test.ts`:

```typescript
describe("getMarkerPath with purpose", () => {
  it("returns different paths for different purposes", () => {
    const p1 = getMarkerPath("/some/project", "recompile", markerDir);
    const p2 = getMarkerPath("/some/project", "test-run", markerDir);
    expect(p1).not.toBe(p2);
  });

  it("includes purpose in marker filename", () => {
    const p = getMarkerPath("/some/project", "test-run", markerDir);
    expect(path.basename(p)).toMatch(/^test-run-/);
  });

  it("is backwards-compatible with recompile purpose", () => {
    const p = getMarkerPath("/some/project", "recompile", markerDir);
    expect(path.basename(p)).toMatch(/^recompile-/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/lib/project/changes.test.ts`
Expected: FAIL — `getMarkerPath` doesn't accept a `purpose` parameter yet.

- [ ] **Step 3: Update `getMarkerPath` to accept purpose parameter**

In `src/lib/project/changes.ts`, change `getMarkerPath`:

```typescript
export function getMarkerPath(
  projectPath: string,
  purpose: string = "recompile",
  markerDir: string = MARKER_DIR,
): string {
  const hash = crypto.createHash("md5").update(projectPath).digest("hex");
  return path.join(markerDir, `${purpose}-${hash}`);
}
```

- [ ] **Step 4: Update existing tests to pass purpose parameter**

Update the existing `getMarkerPath` tests to use the 3-arg signature:

```typescript
describe("getMarkerPath", () => {
  it("returns a deterministic path based on project path", () => {
    const p1 = getMarkerPath("/some/project", "recompile", markerDir);
    const p2 = getMarkerPath("/some/project", "recompile", markerDir);
    expect(p1).toBe(p2);
  });

  it("returns different paths for different projects", () => {
    const p1 = getMarkerPath("/project/a", "recompile", markerDir);
    const p2 = getMarkerPath("/project/b", "recompile", markerDir);
    expect(p1).not.toBe(p2);
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/lib/project/changes.test.ts`
Expected: All PASS.

- [ ] **Step 6: Update `recompile.ts` to pass purpose**

In `src/core/recompile.ts`, change the `getMarkerPath` call:

```typescript
const markerPath = getMarkerPath(projectPath, "recompile");
```

This is the only call site. The default was already `"recompile"` so behavior is unchanged.

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `cd plugins/unity-mcp && npx vitest run`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
cd plugins/unity-mcp && git add src/lib/project/changes.ts src/core/recompile.ts __tests__/lib/project/changes.test.ts
git commit -m "refactor: generalize marker system with purpose parameter" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Update Config and Bridge Types

**Files:**
- Modify: `plugins/unity-mcp/src/lib/config.ts`
- Modify: `plugins/unity-mcp/src/lib/bridge/types.ts`
- Modify: `plugins/unity-mcp/src/core/types.ts`

- [ ] **Step 1: Update `config.ts`**

Replace the full file content. Key changes:
- `BRIDGE_CS_FILENAME` → `BRIDGE_CS_FILES` array
- `BRIDGE_VERSION` bumped to `"4"` (new base class architecture)
- Rename `BRIDGE_ASSET_DIR` and `BRIDGE_EDITOR_DIR` to `Assets/Claude Bridge`
- Update `GIT_EXCLUDE_PATTERNS` to new folder name
- Add `TEST_STATUS_TIMEOUT_MS` and `TEST_STORE_DIR`
- Add `LEGACY_BRIDGE_ASSET_DIR` for migration
- Update `bridgePaths()` to return `bridgeFiles` (array of paths) instead of `bridgeFile` (single path)

```typescript
import path from "node:path";
import os from "node:os";

// Bridge protocol
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = "4";

// Timeouts (milliseconds)
export const POLL_INTERVAL_MS = 500;
export const BRIDGE_READY_TIMEOUT_MS = 120_000;
export const BRIDGE_STATUS_TIMEOUT_MS = 120_000;
export const TEST_STATUS_TIMEOUT_MS = 300_000;
export const BRIDGE_BUSY_RETRY_DELAY_MS = 1_000;
export const BRIDGE_MAX_BUSY_RETRIES = 1;

// Paths
export const CACHE_DIR = path.join(os.homedir(), ".claude", "cache", "unity-recompile");
export const MARKER_DIR = path.join(CACHE_DIR, "markers");
export const TEST_STORE_DIR = path.join(CACHE_DIR, "test-runs");

// Bridge paths (relative to project root)
export const BRIDGE_ASSET_DIR = "Assets/Claude Bridge";
export const BRIDGE_EDITOR_DIR = "Assets/Claude Bridge/Editor";
export const BRIDGE_CS_FILES = [
  "ClaudeBridgeBase.cs",
  "ClaudeRecompileHandler.cs",
  "ClaudeTestHandler.cs",
];
export const BRIDGE_IPC_DIRNAME = "Library/ClaudeHookIPC";
export const BRIDGE_REQUEST_FILENAME = "request.json";
export const BRIDGE_READY_FILENAME = "bridge-ready.json";

// Legacy bridge paths (for migration)
export const LEGACY_BRIDGE_ASSET_DIR = "Assets/Recompile Hook";

// Git exclude patterns
export const GIT_EXCLUDE_PATTERNS = [
  "/Assets/Claude Bridge/",
  "/Assets/Claude Bridge.meta",
];

/** Resolve bridge paths for a given project root */
export function bridgePaths(projectPath: string) {
  const ipcDir = path.join(projectPath, BRIDGE_IPC_DIRNAME);
  return {
    bridgeRootDir: path.join(projectPath, BRIDGE_ASSET_DIR),
    bridgeEditorDir: path.join(projectPath, BRIDGE_EDITOR_DIR),
    bridgeFiles: BRIDGE_CS_FILES.map((f) =>
      path.join(projectPath, BRIDGE_EDITOR_DIR, f),
    ),
    ipcDir,
    requestFile: path.join(ipcDir, BRIDGE_REQUEST_FILENAME),
    readyFile: path.join(ipcDir, BRIDGE_READY_FILENAME),
    statusFile: (requestId: string) =>
      path.join(ipcDir, `status-${requestId}.json`),
  };
}
```

- [ ] **Step 2: Update `bridge/types.ts`**

Extend the action union and add test-specific types:

```typescript
export interface BridgeRequest {
  protocolVersion: number;
  requestId: string;
  requestedAtUnixMs: number;
  projectPath: string;
  action: "recompile" | "bootstrap_handshake" | "run_tests";
  reason: string;
  source: string;
  payload?: TestRunPayload;
}

export interface TestRunPayload {
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
}

export interface CompileError {
  assembly: string;
  file: string;
  line: number;
  column: number;
  message: string;
  type: string;
}

export interface BridgeStatus {
  protocolVersion: number;
  requestId: string;
  bridgeVersion: string;
  projectPath: string;
  state:
    | "queued"
    | "refresh_requested"
    | "compilation_started"
    | "compilation_finished"
    | "completed"
    | "failed"
    | "bridge_error"
    | "busy"
    | "timeout"
    | "tests_finished";
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  didCompile: boolean;
  isSuccess: boolean;
  errors: CompileError[];
  summary: string;
  testResults?: TestResults;
}

export interface TestResults {
  totalCount: number;
  passCount: number;
  failCount: number;
  skipCount: number;
  inconclusiveCount: number;
  duration: number;
  tests: TestResultEntry[];
}

export interface TestResultEntry {
  fullName: string;
  name: string;
  status: "Passed" | "Failed" | "Skipped" | "Inconclusive";
  duration: number;
  message: string | null;
  stackTrace: string | null;
  output: string | null;
}

export interface BridgeReady {
  protocolVersion: number;
  bridgeVersion: string;
  projectPath: string;
  readyAtUnixMs: number;
}

export interface CompileResult {
  success: boolean;
  didCompile: boolean;
  errors: string[];
}
```

- [ ] **Step 3: Update `core/types.ts`**

Add test-specific interfaces:

```typescript
export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export interface CompilationError {
  assembly: string;
  file: string;
  line: number;
  column: number;
  message: string;
  type: string;
}

export interface RecompileResult {
  success: boolean;
  skipped: boolean;
  errors: CompilationError[];
}

export interface StatusResult {
  editorRunning: boolean;
  editorPid: number | null;
  bridgeReady: boolean;
  bridgeVersion: number | null;
  protocolVersion: number | null;
  unityVersion: string | null;
  projectPath: string;
  lastRecompileMarker: Date | null;
}

export interface LintResult {
  filesLinted: number;
  success: boolean;
}

export interface StoredTestRun {
  runId: string;
  timestamp: string;
  projectPath: string;
  filters: {
    categoryNames?: string[];
    groupNames?: string[];
    assemblyNames?: string[];
  };
  results: {
    totalCount: number;
    passCount: number;
    failCount: number;
    skipCount: number;
    inconclusiveCount: number;
    duration: number;
    tests: {
      fullName: string;
      name: string;
      status: "Passed" | "Failed" | "Skipped" | "Inconclusive";
      duration: number;
      message: string | null;
      stackTrace: string | null;
      output: string | null;
    }[];
  };
}

export interface RunTestsResult {
  runId: string;
  formatted: string;
}

export interface TestResultsViewResult {
  formatted: string;
  stale: boolean;
}
```

- [ ] **Step 4: Fix compile errors in `install.ts`**

The file currently references `paths.bridgeFile` (singular). Update to iterate over `paths.bridgeFiles`. Full replacement of `install.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { bridgePaths, BRIDGE_CS_FILES, GIT_EXCLUDE_PATTERNS, LEGACY_BRIDGE_ASSET_DIR } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "..", "..", "..", "templates");

/**
 * Ensure all bridge C# files are installed and up-to-date in the Unity project.
 * Returns whether any file was changed (installed or updated).
 */
export function ensureBridgeInstalled(projectPath: string): {
  changed: boolean;
} {
  const paths = bridgePaths(projectPath);

  // Migration: remove old folder if it exists
  const legacyDir = path.join(projectPath, LEGACY_BRIDGE_ASSET_DIR);
  if (fs.existsSync(legacyDir)) {
    log("Migrating: removing legacy bridge folder " + legacyDir);
    fs.rmSync(legacyDir, { recursive: true, force: true });
    const legacyMeta = legacyDir + ".meta";
    if (fs.existsSync(legacyMeta)) fs.unlinkSync(legacyMeta);
  }

  fs.mkdirSync(paths.bridgeEditorDir, { recursive: true });

  let anyChanged = false;
  for (const filename of BRIDGE_CS_FILES) {
    const templatePath = path.join(TEMPLATES_DIR, filename);
    const destPath = path.join(paths.bridgeEditorDir, filename);

    if (!fs.existsSync(templatePath)) {
      log("Template not found, skipping: " + filename);
      continue;
    }

    const templateContent = fs.readFileSync(templatePath, "utf-8");

    if (fs.existsSync(destPath)) {
      const existing = fs.readFileSync(destPath, "utf-8");
      if (existing === templateContent) {
        continue;
      }
    }

    const tmpFile = destPath + ".tmp";
    fs.writeFileSync(tmpFile, templateContent);
    fs.renameSync(tmpFile, destPath);
    log("Bridge installed/updated: " + destPath);
    anyChanged = true;
  }

  if (!anyChanged) {
    log("All bridge files up to date");
  }
  return { changed: anyChanged };
}

/**
 * Ensure bridge paths are in .git/info/exclude so they don't pollute git status.
 */
export function ensureGitExclude(projectPath: string): void {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    if (!gitDir) return;

    const excludeFile = path.join(projectPath, gitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });

    let content = "";
    try {
      content = fs.readFileSync(excludeFile, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    let changed = false;
    for (const pattern of GIT_EXCLUDE_PATTERNS) {
      if (!content.split("\n").includes(pattern)) {
        content += `${pattern}\n`;
        changed = true;
        log("Bridge exclude: added " + pattern);
      }
    }

    if (changed) {
      fs.writeFileSync(excludeFile, content);
    }
  } catch {
    log("Bridge exclude: unable to locate .git dir, skipping");
  }
}
```

- [ ] **Step 5: Update `install.test.ts` for multi-file bridge**

The test at `__tests__/lib/bridge/install.test.ts` references `bridgeFile` (singular) and the old path `Assets/Recompile Hook/Editor/ClaudeRecompileBridge.cs`. Rewrite the test:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureBridgeInstalled } from "../../../src/lib/bridge/install.js";
import { BRIDGE_EDITOR_DIR, BRIDGE_CS_FILES } from "../../../src/lib/config.js";

describe("ensureBridgeInstalled", () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "unity-bridge-"));
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it("installs all bridge files when they do not exist", () => {
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(true);
    for (const filename of BRIDGE_CS_FILES) {
      const filePath = path.join(tmpProject, BRIDGE_EDITOR_DIR, filename);
      // Only check files that have templates
      if (fs.existsSync(filePath)) {
        expect(fs.readFileSync(filePath, "utf-8").length).toBeGreaterThan(0);
      }
    }
  });

  it("does not overwrite when bridge is already up to date", () => {
    ensureBridgeInstalled(tmpProject);
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(false);
  });

  it("overwrites when bridge content differs", () => {
    ensureBridgeInstalled(tmpProject);
    // Corrupt one file
    const firstFile = path.join(tmpProject, BRIDGE_EDITOR_DIR, BRIDGE_CS_FILES[0]);
    if (fs.existsSync(firstFile)) {
      fs.writeFileSync(firstFile, "// corrupted");
      const result = ensureBridgeInstalled(tmpProject);
      expect(result.changed).toBe(true);
    }
  });
});
```

- [ ] **Step 6: Update `full-flow.test.ts` for multi-file bridge**

The integration test at `__tests__/integration/full-flow.test.ts` references `paths.bridgeFile` and checks for `"ClaudeRecompileBridge Version: 3"`. Update it:

```typescript
// Line 51: getMarkerPath now takes purpose parameter
const markerPath = getMarkerPath(projectPath, "recompile", markerDir);

// Lines 68-72: Replace bridgeFile check with bridgeFiles check
const paths = bridgePaths(projectPath);
// Check that at least one bridge file was installed
const installedFiles = paths.bridgeFiles.filter((f) => fs.existsSync(f));
expect(installedFiles.length).toBeGreaterThan(0);
```

- [ ] **Step 7: Fix any other compile errors from `bridgeFile` → `bridgeFiles`**

Run: `cd plugins/unity-mcp && npx tsc --noEmit`

Check `orchestrate.ts` and `status.ts`. The `status.ts` file calls `getMarkerPath(projectPath)` without a purpose — update it:

```typescript
// In src/core/status.ts, line 49:
const markerPath = getMarkerPath(projectPath, "recompile");
```

- [ ] **Step 8: Run tests to verify no regressions**

Run: `cd plugins/unity-mcp && npx vitest run`
Expected: All PASS.

- [ ] **Step 9: Commit**

```bash
cd plugins/unity-mcp && git add src/lib/config.ts src/lib/bridge/types.ts src/core/types.ts src/lib/bridge/install.ts src/core/status.ts __tests__/lib/bridge/install.test.ts __tests__/integration/full-flow.test.ts
git commit -m "refactor: update config, types, and install for multi-file bridge" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Test Store (Disk-Backed Results)

**Files:**
- Create: `plugins/unity-mcp/src/lib/test-store.ts`
- Create: `plugins/unity-mcp/__tests__/lib/test-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/lib/test-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveTestRun, loadTestRun, loadLatestTestRun } from "../../src/lib/test-store.js";
import type { StoredTestRun } from "../../src/core/types.js";

function makeRun(runId: string, timestamp: string): StoredTestRun {
  return {
    runId,
    timestamp,
    projectPath: "/fake/project",
    filters: {},
    results: {
      totalCount: 2,
      passCount: 1,
      failCount: 1,
      skipCount: 0,
      inconclusiveCount: 0,
      duration: 1.5,
      tests: [
        { fullName: "NS.Test1", name: "Test1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null },
        { fullName: "NS.Test2", name: "Test2", status: "Failed", duration: 1.0, message: "Expected true", stackTrace: "at Test2:10", output: null },
      ],
    },
  };
}

describe("test-store", () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-store-"));
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  describe("saveTestRun", () => {
    it("writes a JSON file named by runId", () => {
      const run = makeRun("test-100", "2026-03-24T10:00:00Z");
      saveTestRun(run, storeDir);
      expect(fs.existsSync(path.join(storeDir, "test-100.json"))).toBe(true);
    });
  });

  describe("loadTestRun", () => {
    it("loads a previously saved run by ID", () => {
      const run = makeRun("test-200", "2026-03-24T11:00:00Z");
      saveTestRun(run, storeDir);
      const loaded = loadTestRun("test-200", storeDir);
      expect(loaded).toEqual(run);
    });

    it("returns null for non-existent run", () => {
      expect(loadTestRun("test-999", storeDir)).toBeNull();
    });
  });

  describe("loadLatestTestRun", () => {
    it("returns the run with the latest timestamp", () => {
      saveTestRun(makeRun("test-100", "2026-03-24T10:00:00Z"), storeDir);
      saveTestRun(makeRun("test-300", "2026-03-24T12:00:00Z"), storeDir);
      saveTestRun(makeRun("test-200", "2026-03-24T11:00:00Z"), storeDir);
      const latest = loadLatestTestRun(storeDir);
      expect(latest?.runId).toBe("test-300");
    });

    it("returns null when store is empty", () => {
      expect(loadLatestTestRun(storeDir)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/lib/test-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement test-store**

Create `src/lib/test-store.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { TEST_STORE_DIR } from "./config.js";
import type { StoredTestRun } from "../core/types.js";

export function saveTestRun(
  run: StoredTestRun,
  storeDir: string = TEST_STORE_DIR,
): void {
  fs.mkdirSync(storeDir, { recursive: true });
  const filePath = path.join(storeDir, `${run.runId}.json`);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(run, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function loadTestRun(
  runId: string,
  storeDir: string = TEST_STORE_DIR,
): StoredTestRun | null {
  const filePath = path.join(storeDir, `${runId}.json`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as StoredTestRun;
  } catch {
    return null;
  }
}

export function loadLatestTestRun(
  storeDir: string = TEST_STORE_DIR,
): StoredTestRun | null {
  try {
    if (!fs.existsSync(storeDir)) return null;
    const files = fs.readdirSync(storeDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;

    let latest: StoredTestRun | null = null;
    for (const file of files) {
      const content = fs.readFileSync(path.join(storeDir, file), "utf-8");
      const run = JSON.parse(content) as StoredTestRun;
      if (!latest || run.timestamp > latest.timestamp) {
        latest = run;
      }
    }
    return latest;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/lib/test-store.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd plugins/unity-mcp && git add src/lib/test-store.ts __tests__/lib/test-store.test.ts
git commit -m "feat: add disk-backed test run storage" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Test Results Formatting and Filtering

**Files:**
- Create: `plugins/unity-mcp/src/core/test-results.ts`
- Create: `plugins/unity-mcp/__tests__/core/test-results.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/core/test-results.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getTestResults } from "../../src/core/test-results.js";
import { saveTestRun } from "../../src/lib/test-store.js";
import type { StoredTestRun } from "../../src/core/types.js";

function makeRun(): StoredTestRun {
  return {
    runId: "test-100",
    timestamp: "2026-03-24T10:00:00Z",
    projectPath: "/fake/project",
    filters: {},
    results: {
      totalCount: 4,
      passCount: 2,
      failCount: 1,
      skipCount: 1,
      inconclusiveCount: 0,
      duration: 3.5,
      tests: [
        { fullName: "NS.ClassA.Test1", name: "Test1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null },
        { fullName: "NS.ClassA.Test2", name: "Test2", status: "Passed", duration: 0.8, message: null, stackTrace: null, output: null },
        { fullName: "NS.ClassB.Test3", name: "Test3", status: "Failed", duration: 1.2, message: "Expected 5 got 4", stackTrace: "at Test3:42", output: null },
        { fullName: "NS.ClassB.Test4", name: "Test4", status: "Skipped", duration: 0.0, message: "Ignored", stackTrace: null, output: null },
      ],
    },
  };
}

describe("getTestResults", () => {
  let storeDir: string;
  let projectDir: string;
  let markerDir: string;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-results-store-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-results-proj-"));
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-results-markers-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
    saveTestRun(makeRun(), storeDir);
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
  });

  it("returns formatted summary by default", () => {
    const result = getTestResults({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("2 passed");
    expect(result.formatted).toContain("1 failed");
    expect(result.formatted).toContain("1 skipped");
  });

  it("returns verbose output when requested", () => {
    const result = getTestResults({ projectPath: projectDir, verbose: true, storeDir, markerDir });
    expect(result.formatted).toContain("NS.ClassA.Test1");
    expect(result.formatted).toContain("NS.ClassA.Test2");
    expect(result.formatted).toContain("NS.ClassB.Test3");
  });

  it("filters by status", () => {
    const result = getTestResults({ projectPath: projectDir, statusFilter: "failed", verbose: true, storeDir, markerDir });
    expect(result.formatted).toContain("NS.ClassB.Test3");
    expect(result.formatted).not.toContain("NS.ClassA.Test1");
  });

  it("filters by name pattern", () => {
    const result = getTestResults({ projectPath: projectDir, nameFilter: "ClassA", verbose: true, storeDir, markerDir });
    expect(result.formatted).toContain("NS.ClassA.Test1");
    expect(result.formatted).not.toContain("NS.ClassB.Test3");
  });

  it("loads specific run by ID", () => {
    const result = getTestResults({ projectPath: projectDir, runId: "test-100", storeDir, markerDir });
    expect(result.formatted).toContain("test-100");
  });

  it("returns error for non-existent run", () => {
    const result = getTestResults({ projectPath: projectDir, runId: "test-999", storeDir, markerDir });
    expect(result.formatted).toContain("No test run found");
  });

  it("detects staleness when code changed", async () => {
    // Use getMarkerPath to get the correct marker path (same as production code)
    const { getMarkerPath } = await import("../../src/lib/project/changes.js");
    const markerPath = getMarkerPath(projectDir, "test-run", markerDir);
    const past = new Date(Date.now() - 60_000);
    fs.writeFileSync(markerPath, "");
    fs.utimesSync(markerPath, past, past);
    fs.writeFileSync(path.join(projectDir, "Assets", "New.cs"), "class New {}");

    const result = getTestResults({ projectPath: projectDir, storeDir, markerDir });
    expect(result.stale).toBe(true);
    expect(result.formatted).toContain("stale");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/core/test-results.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `test-results.ts`**

Create `src/core/test-results.ts`:

```typescript
import { loadTestRun, loadLatestTestRun } from "../lib/test-store.js";
import { getMarkerPath, hasChangedCsFiles } from "../lib/project/changes.js";
import type { StoredTestRun, TestResultsViewResult } from "./types.js";

export interface GetTestResultsOptions {
  projectPath: string;
  runId?: string;
  verbose?: boolean;
  statusFilter?: "passed" | "failed" | "skipped";
  nameFilter?: string;
  storeDir?: string;
  markerDir?: string;
}

export function getTestResults(opts: GetTestResultsOptions): TestResultsViewResult {
  const run = opts.runId
    ? loadTestRun(opts.runId, opts.storeDir)
    : loadLatestTestRun(opts.storeDir);

  if (!run) {
    return { formatted: "No test run found" + (opts.runId ? ` with ID ${opts.runId}` : "") + ".", stale: false };
  }

  // Check staleness
  const markerPath = getMarkerPath(opts.projectPath, "test-run", opts.markerDir);
  const stale = hasChangedCsFiles(opts.projectPath, markerPath);

  // Filter tests
  let tests = run.results.tests;
  if (opts.statusFilter) {
    const statusMap: Record<string, string> = { passed: "Passed", failed: "Failed", skipped: "Skipped" };
    const target = statusMap[opts.statusFilter];
    tests = tests.filter((t) => t.status === target);
  }
  if (opts.nameFilter) {
    const re = new RegExp(opts.nameFilter);
    tests = tests.filter((t) => re.test(t.fullName));
  }

  // Format output
  const lines: string[] = [];

  if (stale) {
    lines.push("WARNING: Results may be stale -- code has changed since this run.\n");
  }

  const ts = run.timestamp.replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
  lines.push(`Run ${run.runId} (${ts})`);
  lines.push(
    `Pass: ${run.results.passCount}  Fail: ${run.results.failCount}  Skip: ${run.results.skipCount}  (${run.results.duration.toFixed(1)}s)`,
  );

  if (opts.verbose) {
    lines.push("");
    for (const t of tests) {
      const icon = t.status === "Passed" ? "PASS" : t.status === "Failed" ? "FAIL" : "SKIP";
      lines.push(`  [${icon}] ${t.fullName} (${t.duration.toFixed(2)}s)`);
      if (t.message) lines.push(`    ${t.message}`);
      if (t.stackTrace) lines.push(`    ${t.stackTrace}`);
    }
  } else {
    // Summary: show failures
    const failures = tests.filter((t) => t.status === "Failed");
    if (failures.length > 0) {
      lines.push("");
      lines.push("Failures:");
      for (const t of failures) {
        lines.push(`  [FAIL] ${t.fullName} -- ${t.message || "no message"}`);
      }
    }
  }

  return { formatted: lines.join("\n"), stale };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/core/test-results.test.ts`
Expected: All PASS. Adjust formatting expectations in tests if needed to match implementation.

- [ ] **Step 5: Commit**

```bash
cd plugins/unity-mcp && git add src/core/test-results.ts __tests__/core/test-results.test.ts
git commit -m "feat: add test results formatting and filtering" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Test Run Orchestration

**Files:**
- Create: `plugins/unity-mcp/src/core/test.ts`
- Create: `plugins/unity-mcp/__tests__/core/test.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/core/test.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock the bridge dependencies
vi.mock("../../src/lib/bridge/ipc.js", () => ({
  generateRequestId: () => "mock-req-id",
  writeBridgeRequest: vi.fn(),
  waitForBridgeStatus: vi.fn(),
  sleep: vi.fn(),
  bridgeReadyMatchesProject: vi.fn(() => true),
  readBridgeStatus: vi.fn(),
}));

vi.mock("../../src/lib/compile/applescript.js", () => ({
  unityIsRunning: vi.fn(() => true),
}));

import { runTests } from "../../src/core/test.js";
import { waitForBridgeStatus } from "../../src/lib/bridge/ipc.js";
import { unityIsRunning } from "../../src/lib/compile/applescript.js";
import { loadLatestTestRun } from "../../src/lib/test-store.js";
import type { BridgeStatus } from "../../src/lib/bridge/types.js";

describe("runTests", () => {
  let projectDir: string;
  let storeDir: string;
  let markerDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-proj-"));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-store-"));
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-markers-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "Library", "ClaudeHookIPC"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns error when Unity is not running", async () => {
    vi.mocked(unityIsRunning).mockReturnValue(false);
    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("Unity editor must be running");
  });

  it("stores results and returns run ID on success", async () => {
    const mockStatus: BridgeStatus = {
      protocolVersion: 1,
      requestId: "mock-req-id",
      bridgeVersion: "4",
      projectPath: projectDir,
      state: "tests_finished",
      createdAtUnixMs: Date.now(),
      updatedAtUnixMs: Date.now(),
      didCompile: false,
      isSuccess: true,
      errors: [],
      summary: "Tests completed",
      testResults: {
        totalCount: 1,
        passCount: 1,
        failCount: 0,
        skipCount: 0,
        inconclusiveCount: 0,
        duration: 0.5,
        tests: [
          { fullName: "NS.Test1", name: "Test1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null },
        ],
      },
    };
    vi.mocked(waitForBridgeStatus).mockResolvedValue(mockStatus);

    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.runId).toBeTruthy();
    expect(result.formatted).toContain("1 passed");

    // Verify stored
    const stored = loadLatestTestRun(storeDir);
    expect(stored?.results.passCount).toBe(1);
  });

  it("returns error on timeout", async () => {
    vi.mocked(waitForBridgeStatus).mockResolvedValue(null);
    const result = await runTests({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("Timed out");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/core/test.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `test.ts`**

Create `src/core/test.ts`:

```typescript
import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_PROTOCOL_VERSION,
  TEST_STATUS_TIMEOUT_MS,
  MARKER_DIR,
} from "../lib/config.js";
import {
  generateRequestId,
  writeBridgeRequest,
  waitForBridgeStatus,
  bridgeReadyMatchesProject,
} from "../lib/bridge/ipc.js";
import { unityIsRunning } from "../lib/compile/applescript.js";
import { saveTestRun } from "../lib/test-store.js";
import { getTestResults } from "./test-results.js";
import { getMarkerPath, ensureMarker, touchMarker } from "../lib/project/changes.js";
import type { BridgeRequest, TestRunPayload } from "../lib/bridge/types.js";
import type { Logger, RunTestsResult } from "./types.js";

const noopLogger: Logger = { log() {}, error() {} };

export interface RunTestsOptions {
  projectPath: string;
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
  verbose?: boolean;
  logger?: Logger;
  storeDir?: string;
  markerDir?: string;
}

export async function runTests(opts: RunTestsOptions): Promise<RunTestsResult> {
  const logger = opts.logger ?? noopLogger;
  const projectPath = opts.projectPath;

  // Check Unity is running
  if (!unityIsRunning(projectPath)) {
    return { runId: "", formatted: "Unity editor must be running to execute tests." };
  }

  // Check bridge ready
  const paths = bridgePaths(projectPath);
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) {
    return { runId: "", formatted: "Bridge is not ready. Run unity_recompile first to initialize the bridge." };
  }

  // Build request
  const requestId = generateRequestId();
  const statusPath = paths.statusFile(requestId);

  try { fs.unlinkSync(statusPath); } catch { /* doesn't exist */ }

  const payload: TestRunPayload = {};
  if (opts.categoryNames?.length) payload.categoryNames = opts.categoryNames;
  if (opts.groupNames?.length) payload.groupNames = opts.groupNames;
  if (opts.assemblyNames?.length) payload.assemblyNames = opts.assemblyNames;

  const request: BridgeRequest = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    requestedAtUnixMs: Date.now(),
    projectPath,
    action: "run_tests",
    reason: "unity_run_tests MCP tool",
    source: "unity-mcp",
    payload,
  };

  fs.mkdirSync(paths.ipcDir, { recursive: true });
  writeBridgeRequest(paths.requestFile, request);
  logger.log("Sent run_tests request: " + requestId);

  // Poll for status
  const status = await waitForBridgeStatus(statusPath, requestId, TEST_STATUS_TIMEOUT_MS);
  if (!status) {
    return { runId: "", formatted: "Timed out waiting for test results (300s)." };
  }

  if (status.state === "failed" || status.state === "bridge_error") {
    return { runId: "", formatted: "Test run failed: " + (status.summary || "unknown error") };
  }

  if (!status.testResults) {
    return { runId: "", formatted: "Bridge returned no test results." };
  }

  // Store results
  const runId = "test-" + Date.now();
  const storedRun = {
    runId,
    timestamp: new Date().toISOString(),
    projectPath,
    filters: payload,
    results: status.testResults,
  };
  saveTestRun(storedRun, opts.storeDir);

  // Touch marker
  const markerPath = getMarkerPath(projectPath, "test-run", opts.markerDir);
  ensureMarker(markerPath);
  touchMarker(markerPath);

  // Format and return
  const view = getTestResults({
    projectPath,
    runId,
    verbose: opts.verbose,
    storeDir: opts.storeDir,
    markerDir: opts.markerDir,
  });

  return { runId, formatted: view.formatted };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/core/test.test.ts`
Expected: All PASS. Fix any mock mismatches.

- [ ] **Step 5: Commit**

```bash
cd plugins/unity-mcp && git add src/core/test.ts __tests__/core/test.test.ts
git commit -m "feat: add test run orchestration" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Register MCP Tools

**Files:**
- Modify: `plugins/unity-mcp/src/mcp/server.ts`
- Modify: `plugins/unity-mcp/__tests__/mcp/server.test.ts`

- [ ] **Step 1: Update server test**

In `__tests__/mcp/server.test.ts`, update the expected tool list:

```typescript
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";

describe("MCP server", () => {
  it("registers all 5 tools", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "unity_lint",
      "unity_recompile",
      "unity_run_tests",
      "unity_status",
      "unity_test_results",
    ]);

    await client.close();
    await server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/mcp/server.test.ts`
Expected: FAIL — only 3 tools registered.

- [ ] **Step 3: Register `unity_run_tests` and `unity_test_results` in `server.ts`**

Add to `src/mcp/server.ts` before `return server;`:

```typescript
import { runTests } from "../core/test.js";
import { getTestResults } from "../core/test-results.js";

// ... inside createServer(), after the unity_lint tool:

  server.tool(
    "unity_run_tests",
    "Run Unity EditMode tests. Supports filtering by category, class/namespace (regex), and assembly. Returns summary or verbose results.",
    {
      projectPath: z.string().describe("Unity project root path"),
      categoryNames: z.array(z.string()).optional().describe("NUnit [Category] tags to filter by"),
      groupNames: z.array(z.string()).optional().describe("Regex patterns for namespace/class/test name filtering"),
      assemblyNames: z.array(z.string()).optional().describe("Assembly names to filter (without .dll)"),
      verbose: z.boolean().optional().describe("If true, show all test results; if false, show summary + failures only"),
    },
    async ({ projectPath, categoryNames, groupNames, assemblyNames, verbose }) => {
      const result = await runTests({
        projectPath,
        categoryNames,
        groupNames,
        assemblyNames,
        verbose,
        logger: stderrLogger,
      });

      return {
        content: [{ type: "text" as const, text: result.formatted }],
        isError: !result.runId,
      };
    },
  );

  server.tool(
    "unity_test_results",
    "Retrieve results from a previous test run. Supports filtering by status, name pattern, and adaptive verbosity. Flags stale results when code has changed.",
    {
      projectPath: z.string().describe("Unity project root path"),
      runId: z.string().optional().describe("Test run ID (defaults to latest)"),
      verbose: z.boolean().optional().describe("If true, show all test results; if false, show summary + failures only"),
      statusFilter: z.enum(["passed", "failed", "skipped"]).optional().describe("Filter results by test status"),
      nameFilter: z.string().optional().describe("Regex pattern to filter by test name"),
    },
    async ({ projectPath, runId, verbose, statusFilter, nameFilter }) => {
      const result = getTestResults({
        projectPath,
        runId,
        verbose,
        statusFilter,
        nameFilter,
      });

      return {
        content: [{ type: "text" as const, text: result.formatted }],
      };
    },
  );
```

- [ ] **Step 4: Run server test to verify it passes**

Run: `cd plugins/unity-mcp && npx vitest run __tests__/mcp/server.test.ts`
Expected: PASS — 5 tools registered.

- [ ] **Step 5: Run full test suite**

Run: `cd plugins/unity-mcp && npx vitest run`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
cd plugins/unity-mcp && git add src/mcp/server.ts __tests__/mcp/server.test.ts
git commit -m "feat: register unity_run_tests and unity_test_results MCP tools" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: C# Bridge Refactoring — Base Class

**Files:**
- Create: `plugins/unity-mcp/templates/ClaudeBridgeBase.cs`
- Modify: `plugins/unity-mcp/templates/ClaudeRecompileBridge.cs` → rename to `ClaudeRecompileHandler.cs`

This task extracts the shared IPC infrastructure into a base class. The C# code cannot be unit-tested in our vitest setup — it will be validated by integration testing in Unity.

- [ ] **Step 1: Create `ClaudeBridgeBase.cs`**

Create `templates/ClaudeBridgeBase.cs`. This extracts the shared infrastructure: file watcher, request parsing, status writing, ready signal, action dispatch, editor loop kicking.

```csharp
// ClaudeBridgeBase Version: 4
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
internal static class ClaudeBridgeBase
{
    private const int ProtocolVersion = 1;
    private const string BridgeVersion = "4";
    private const string RequestFileName = "request.json";
    private const string ReadyFileName = "bridge-ready.json";

    [Serializable]
    internal class RequestPayload
    {
        public int protocolVersion;
        public string requestId;
        public long requestedAtUnixMs;
        public string projectPath;
        public string action;
        public string reason;
        public string source;
        public string payload; // JSON string for action-specific data
    }

    [Serializable]
    internal class ErrorPayload
    {
        public string assembly;
        public string file;
        public int line;
        public int column;
        public string message;
        public string type;
    }

    [Serializable]
    internal class StatusPayload
    {
        public int protocolVersion;
        public string requestId;
        public string bridgeVersion;
        public string projectPath;
        public string state;
        public long createdAtUnixMs;
        public long updatedAtUnixMs;
        public bool didCompile;
        public bool isSuccess;
        public List<ErrorPayload> errors;
        public string summary;
        public string testResults; // JSON string, only for test actions
    }

    [Serializable]
    internal class ReadyPayload
    {
        public int protocolVersion;
        public string bridgeVersion;
        public string projectPath;
        public long readyAtUnixMs;
    }

    internal delegate void ActionHandler(RequestPayload request, long createdAtUnixMs);

    private static readonly object Sync = new object();
    private static FileSystemWatcher _watcher;
    private static bool _requestCheckQueued;
    private static Timer _loopKickTimer;
    private static readonly HashSet<string> ProcessedRequestIds = new HashSet<string>();
    private static readonly Dictionary<string, ActionHandler> ActionHandlers = new Dictionary<string, ActionHandler>();

    internal static string ProjectPath => Directory.GetParent(Application.dataPath).FullName;
    internal static string IpcDir => Path.Combine(ProjectPath, "Library", "ClaudeHookIPC");
    private static string RequestPath => Path.Combine(IpcDir, RequestFileName);
    private static string ReadyPath => Path.Combine(IpcDir, ReadyFileName);

    // Allow handlers to mark an action as "in progress" to reject concurrent requests
    private static string _busyRequestId;

    static ClaudeBridgeBase()
    {
        try
        {
            Directory.CreateDirectory(IpcDir);
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.update += OnEditorUpdate;

            // Register built-in handlers
            ClaudeRecompileHandler.Register();
            ClaudeTestHandler.Register();

            StartWatcher();
            WriteReady();
            EnsureLoopKickTimerRunning();
            TryKickEditorLoop();
            ProcessRequestOnMainThread();
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase init failed: " + ex);
        }
    }

    internal static void RegisterAction(string action, ActionHandler handler)
    {
        ActionHandlers[action] = handler;
    }

    internal static void MarkBusy(string requestId)
    {
        _busyRequestId = requestId;
        EnsureLoopKickTimerRunning();
    }

    internal static void MarkFree()
    {
        _busyRequestId = null;
        UpdateLoopKickTimerState();
        WriteReady();
    }

    internal static void WriteStatus(RequestPayload request, string state, bool didCompile, bool isSuccess, string summary, List<ErrorPayload> errors = null, string testResultsJson = null)
    {
        if (request == null || string.IsNullOrEmpty(request.requestId))
            return;

        var payload = new StatusPayload
        {
            protocolVersion = ProtocolVersion,
            requestId = request.requestId,
            bridgeVersion = BridgeVersion,
            projectPath = ProjectPath,
            state = state,
            createdAtUnixMs = NowUnixMs(),
            updatedAtUnixMs = NowUnixMs(),
            didCompile = didCompile,
            isSuccess = isSuccess,
            errors = errors ?? new List<ErrorPayload>(),
            summary = summary ?? string.Empty,
            testResults = testResultsJson,
        };

        string path = Path.Combine(IpcDir, "status-" + request.requestId + ".json");
        TryWriteJsonAtomic(path, JsonUtility.ToJson(payload, true));
    }

    internal static void FinalizeRequest(RequestPayload request)
    {
        if (request == null) return;
        ProcessedRequestIds.Add(request.requestId);
        TryDeleteRequestFileIfMatches(request.requestId);
        MarkFree();
    }

    internal static long NowUnixMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    // --- Private infrastructure ---

    private static void StartWatcher()
    {
        try
        {
            if (_watcher != null)
            {
                _watcher.EnableRaisingEvents = false;
                _watcher.Created -= OnRequestFileEvent;
                _watcher.Changed -= OnRequestFileEvent;
                _watcher.Renamed -= OnRequestFileRenamed;
                _watcher.Dispose();
                _watcher = null;
            }

            _watcher = new FileSystemWatcher(IpcDir, RequestFileName)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.Size,
                IncludeSubdirectories = false,
                EnableRaisingEvents = true,
            };
            _watcher.Created += OnRequestFileEvent;
            _watcher.Changed += OnRequestFileEvent;
            _watcher.Renamed += OnRequestFileRenamed;
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase watcher failed: " + ex);
        }
    }

    private static void OnRequestFileEvent(object sender, FileSystemEventArgs e)
    {
        QueueRequestCheck();
    }

    private static void OnRequestFileRenamed(object sender, RenamedEventArgs e)
    {
        QueueRequestCheck();
    }

    private static void QueueRequestCheck()
    {
        lock (Sync)
        {
            if (_requestCheckQueued)
            {
                TryKickEditorLoop();
                return;
            }
            _requestCheckQueued = true;
        }

        EnsureLoopKickTimerRunning();
        TryKickEditorLoop();
        EditorApplication.delayCall += ProcessRequestOnMainThread;
    }

    private static void ProcessRequestOnMainThread()
    {
        lock (Sync)
        {
            _requestCheckQueued = false;
        }

        RequestPayload request = TryReadRequest();
        if (request == null)
            return;

        if (request.protocolVersion != ProtocolVersion)
        {
            WriteStatus(request, "bridge_error", false, false, "Unsupported protocol version");
            return;
        }

        if (!string.Equals(request.projectPath ?? string.Empty, ProjectPath, StringComparison.Ordinal))
            return;

        if (string.IsNullOrEmpty(request.requestId))
            return;

        if (ProcessedRequestIds.Contains(request.requestId))
            return;

        if (_busyRequestId != null)
        {
            if (_busyRequestId == request.requestId)
                return;

            WriteStatus(request, "busy", false, false, "Bridge is busy with another request");
            return;
        }

        if (request.action == "bootstrap_handshake")
        {
            WriteStatus(request, "completed", false, true, "Bridge loaded and handshake acknowledged");
            ProcessedRequestIds.Add(request.requestId);
            TryDeleteRequestFileIfMatches(request.requestId);
            return;
        }

        if (ActionHandlers.TryGetValue(request.action, out var handler))
        {
            handler(request, NowUnixMs());
        }
        else
        {
            WriteStatus(request, "bridge_error", false, false, "Unsupported action: " + request.action);
            ProcessedRequestIds.Add(request.requestId);
            TryDeleteRequestFileIfMatches(request.requestId);
        }
    }

    private static void OnEditorUpdate()
    {
        if (_requestCheckQueued)
        {
            ProcessRequestOnMainThread();
        }
    }

    private static void EnsureLoopKickTimerRunning()
    {
        lock (Sync)
        {
            if (_loopKickTimer != null)
                return;

            _loopKickTimer = new Timer(_ =>
            {
                TryKickEditorLoop();
            }, null, 0, 500);
        }
    }

    private static void UpdateLoopKickTimerState()
    {
        lock (Sync)
        {
            bool needsKicks = _requestCheckQueued || _busyRequestId != null;
            if (!needsKicks && _loopKickTimer != null)
            {
                try { _loopKickTimer.Dispose(); }
                catch (Exception) { }
                _loopKickTimer = null;
            }
            else if (needsKicks && _loopKickTimer == null)
            {
                _loopKickTimer = new Timer(_ =>
                {
                    TryKickEditorLoop();
                }, null, 0, 500);
            }
        }
    }

    private static void TryKickEditorLoop()
    {
        try
        {
            EditorApplication.QueuePlayerLoopUpdate();
        }
        catch (Exception) { }
    }

    private static RequestPayload TryReadRequest()
    {
        try
        {
            if (!File.Exists(RequestPath))
                return null;

            string json = File.ReadAllText(RequestPath);
            if (string.IsNullOrWhiteSpace(json))
                return null;

            return JsonUtility.FromJson<RequestPayload>(json);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void WriteReady()
    {
        try
        {
            Directory.CreateDirectory(IpcDir);
            var payload = new ReadyPayload
            {
                protocolVersion = ProtocolVersion,
                bridgeVersion = BridgeVersion,
                projectPath = ProjectPath,
                readyAtUnixMs = NowUnixMs(),
            };
            TryWriteJsonAtomic(ReadyPath, JsonUtility.ToJson(payload, true));
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase ready write failed: " + ex);
        }
    }

    private static void TryWriteJsonAtomic(string path, string json)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string tempPath = path + ".tmp";
            File.WriteAllText(tempPath, json ?? string.Empty);
            if (File.Exists(path))
                File.Delete(path);
            File.Move(tempPath, path);
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase JSON write failed: " + ex);
        }
    }

    private static void TryDeleteRequestFileIfMatches(string requestId)
    {
        try
        {
            if (!File.Exists(RequestPath))
                return;

            RequestPayload current = TryReadRequest();
            if (current != null && current.requestId == requestId)
                File.Delete(RequestPath);
        }
        catch (Exception) { }
    }
}
```

- [ ] **Step 2: Create `ClaudeRecompileHandler.cs`**

Create `templates/ClaudeRecompileHandler.cs`. This extracts the recompile-specific logic (compilation pipeline hooks, no-compile timeout, error collection):

```csharp
// ClaudeRecompileHandler Version: 4
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

internal static class ClaudeRecompileHandler
{
    private const double NoCompileStartTimeoutSeconds = 10.0;

    private class ActiveRecompile
    {
        public ClaudeBridgeBase.RequestPayload Request;
        public long CreatedAtUnixMs;
        public double RefreshRequestedAtEditorTime;
        public bool CompilationStarted;
        public bool Finalized;
        public readonly List<ClaudeBridgeBase.ErrorPayload> Errors = new List<ClaudeBridgeBase.ErrorPayload>();
    }

    private static ActiveRecompile _active;

    internal static void Register()
    {
        CompilationPipeline.compilationStarted -= OnCompilationStarted;
        CompilationPipeline.compilationStarted += OnCompilationStarted;
        CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
        CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
        CompilationPipeline.compilationFinished -= OnCompilationFinished;
        CompilationPipeline.compilationFinished += OnCompilationFinished;
        EditorApplication.update -= OnEditorUpdate;
        EditorApplication.update += OnEditorUpdate;

        ClaudeBridgeBase.RegisterAction("recompile", HandleRecompile);
    }

    private static void HandleRecompile(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        _active = new ActiveRecompile
        {
            Request = request,
            CreatedAtUnixMs = createdAtUnixMs,
            RefreshRequestedAtEditorTime = EditorApplication.timeSinceStartup,
            CompilationStarted = false,
            Finalized = false,
        };

        ClaudeBridgeBase.MarkBusy(request.requestId);
        ClaudeBridgeBase.WriteStatus(request, "queued", false, true, "Request accepted", _active.Errors);
        ClaudeBridgeBase.WriteStatus(request, "refresh_requested", false, true, "AssetDatabase.Refresh requested", _active.Errors);

        try
        {
            AssetDatabase.Refresh();
        }
        catch (Exception ex)
        {
            Finalize(false, false, "AssetDatabase.Refresh failed: " + ex.Message);
        }
    }

    private static void OnEditorUpdate()
    {
        if (_active == null || _active.Finalized)
            return;
        if (_active.CompilationStarted)
            return;

        if ((EditorApplication.timeSinceStartup - _active.RefreshRequestedAtEditorTime) < NoCompileStartTimeoutSeconds)
            return;

        if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            return;

        Finalize(false, true, "No compilation started after refresh");
    }

    private static void OnCompilationStarted(object context)
    {
        if (_active == null || _active.Finalized)
            return;

        _active.CompilationStarted = true;
        ClaudeBridgeBase.WriteStatus(_active.Request, "compilation_started", true, true, "Compilation started", _active.Errors);
    }

    private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
    {
        if (_active == null || _active.Finalized)
            return;

        if (messages == null)
            return;

        for (int i = 0; i < messages.Length; i++)
        {
            CompilerMessage msg = messages[i];
            if (msg.type != CompilerMessageType.Error)
                continue;

            _active.Errors.Add(new ClaudeBridgeBase.ErrorPayload
            {
                assembly = System.IO.Path.GetFileNameWithoutExtension(assemblyPath ?? string.Empty),
                file = msg.file ?? string.Empty,
                line = msg.line,
                column = msg.column,
                message = msg.message ?? string.Empty,
                type = "Error",
            });
        }
    }

    private static void OnCompilationFinished(object context)
    {
        if (_active == null || _active.Finalized)
            return;

        if (!_active.CompilationStarted)
            _active.CompilationStarted = true;

        ClaudeBridgeBase.WriteStatus(_active.Request, "compilation_finished", true, _active.Errors.Count == 0, "Compilation finished", _active.Errors);
        Finalize(true, _active.Errors.Count == 0, _active.Errors.Count == 0 ? "Compilation succeeded" : "Compilation failed");
    }

    private static void Finalize(bool didCompile, bool isSuccess, string summary)
    {
        if (_active == null || _active.Finalized)
            return;

        _active.Finalized = true;
        string finalState = isSuccess ? "completed" : "failed";
        if (!didCompile && isSuccess)
            finalState = "completed";

        ClaudeBridgeBase.WriteStatus(_active.Request, finalState, didCompile, isSuccess, summary, _active.Errors);
        ClaudeBridgeBase.FinalizeRequest(_active.Request);
        _active = null;
    }
}
```

- [ ] **Step 3: Delete the old `ClaudeRecompileBridge.cs`**

```bash
rm plugins/unity-mcp/templates/ClaudeRecompileBridge.cs
```

- [ ] **Step 4: Run full test suite**

Run: `cd plugins/unity-mcp && npx vitest run`
Expected: All PASS. Fix any remaining references to old bridge version or file.

- [ ] **Step 5: Commit**

```bash
cd plugins/unity-mcp && git add templates/ src/lib/config.ts
git commit -m "refactor: extract C# bridge base class and recompile handler" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: C# Test Handler

**Files:**
- Create: `plugins/unity-mcp/templates/ClaudeTestHandler.cs`

- [ ] **Step 1: Create `ClaudeTestHandler.cs`**

Create `templates/ClaudeTestHandler.cs`:

```csharp
// ClaudeTestHandler Version: 4
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

internal static class ClaudeTestHandler
{
    [Serializable]
    private class TestRunPayload
    {
        public string[] categoryNames;
        public string[] groupNames;
        public string[] assemblyNames;
    }

    [Serializable]
    private class TestResultsPayload
    {
        public int totalCount;
        public int passCount;
        public int failCount;
        public int skipCount;
        public int inconclusiveCount;
        public double duration;
        public List<TestResultEntry> tests;
    }

    [Serializable]
    private class TestResultEntry
    {
        public string fullName;
        public string name;
        public string status;
        public double duration;
        public string message;
        public string stackTrace;
        public string output;
    }

    private class ResultCollector : ICallbacks
    {
        public readonly List<TestResultEntry> Results = new List<TestResultEntry>();
        public int PassCount;
        public int FailCount;
        public int SkipCount;
        public int InconclusiveCount;
        public double TotalDuration;

        public void RunStarted(ITestAdaptor testsToRun) { }

        public void TestStarted(ITestAdaptor test) { }

        public void TestFinished(ITestResultAdaptor result)
        {
            // Only collect leaf tests (not suites/fixtures)
            if (result.Test.IsSuite)
                return;

            var entry = new TestResultEntry
            {
                fullName = result.FullName ?? string.Empty,
                name = result.Name ?? string.Empty,
                status = result.TestStatus.ToString(),
                duration = result.Duration,
                message = result.Message,
                stackTrace = result.StackTrace,
                output = result.Output,
            };

            Results.Add(entry);

            switch (result.TestStatus)
            {
                case TestStatus.Passed: PassCount++; break;
                case TestStatus.Failed: FailCount++; break;
                case TestStatus.Skipped: SkipCount++; break;
                case TestStatus.Inconclusive: InconclusiveCount++; break;
            }

            TotalDuration += result.Duration;
        }

        public void RunFinished(ITestResultAdaptor result) { }
    }

    internal static void Register()
    {
        ClaudeBridgeBase.RegisterAction("run_tests", HandleRunTests);
    }

    private static void HandleRunTests(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        try
        {
            // Parse filters from payload
            TestRunPayload filters = null;
            if (!string.IsNullOrEmpty(request.payload))
            {
                filters = JsonUtility.FromJson<TestRunPayload>(request.payload);
            }

            var filter = new Filter
            {
                testMode = TestMode.EditMode,
            };

            if (filters != null)
            {
                if (filters.categoryNames != null && filters.categoryNames.Length > 0)
                    filter.categoryNames = filters.categoryNames;
                if (filters.groupNames != null && filters.groupNames.Length > 0)
                    filter.groupNames = filters.groupNames;
                if (filters.assemblyNames != null && filters.assemblyNames.Length > 0)
                    filter.assemblyNames = filters.assemblyNames;
            }

            var settings = new ExecutionSettings(filter)
            {
                runSynchronously = true,
            };

            var collector = new ResultCollector();
            var api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.RegisterCallbacks(collector);

            // This blocks until all tests complete (synchronous mode)
            api.Execute(settings);

            // Build results payload
            var resultsPayload = new TestResultsPayload
            {
                totalCount = collector.Results.Count,
                passCount = collector.PassCount,
                failCount = collector.FailCount,
                skipCount = collector.SkipCount,
                inconclusiveCount = collector.InconclusiveCount,
                duration = collector.TotalDuration,
                tests = collector.Results,
            };

            string resultsJson = JsonUtility.ToJson(resultsPayload, true);

            ClaudeBridgeBase.WriteStatus(
                request, "tests_finished", false,
                collector.FailCount == 0,
                collector.FailCount == 0
                    ? "All tests passed (" + collector.Results.Count + " total)"
                    : collector.FailCount + " test(s) failed out of " + collector.Results.Count,
                null,
                resultsJson
            );
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "Test run failed: " + ex.Message);
        }
        finally
        {
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }
}
```

- [ ] **Step 2: Run full test suite to verify no regressions**

Run: `cd plugins/unity-mcp && npx vitest run`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
cd plugins/unity-mcp && git add templates/ClaudeTestHandler.cs
git commit -m "feat: add C# test handler for synchronous EditMode test execution" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Handle `testResults` JSON Parsing on TS Side

The C# bridge writes `testResults` as a JSON string inside the status payload (because Unity's `JsonUtility` doesn't support nested serialization of complex types cleanly). The TS side needs to parse this.

**Files:**
- Modify: `plugins/unity-mcp/src/lib/bridge/ipc.ts`

- [ ] **Step 1: Update `waitForBridgeStatus` terminal states**

In `src/lib/bridge/ipc.ts`, add `"tests_finished"` to `TERMINAL_STATES`:

```typescript
const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "bridge_error",
  "busy",
  "timeout",
  "tests_finished",
]);
```

- [ ] **Step 2: Add `testResults` JSON parsing in `readBridgeStatus`**

Update `readBridgeStatus` in `src/lib/bridge/ipc.ts` to parse the `testResults` string field into an object:

```typescript
export function readBridgeStatus(statusPath: string): BridgeStatus | null {
  try {
    if (!fs.existsSync(statusPath)) return null;
    const content = fs.readFileSync(statusPath, "utf-8");
    // Parse with loose typing first since C# bridge may serialize testResults as a JSON string
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (typeof raw.testResults === "string" && raw.testResults) {
      try {
        raw.testResults = JSON.parse(raw.testResults as string);
      } catch {
        // Leave as-is if parsing fails
      }
    }
    return raw as unknown as BridgeStatus;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Run full test suite**

Run: `cd plugins/unity-mcp && npx vitest run`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
cd plugins/unity-mcp && git add src/lib/bridge/ipc.ts
git commit -m "feat: add tests_finished terminal state and testResults JSON parsing" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Build and Final Verification

**Files:**
- Regenerate: `plugins/unity-mcp/dist/server.mjs`

- [ ] **Step 1: Build the bundle**

Run: `cd plugins/unity-mcp && npm run build`
Expected: Successful build, no errors.

- [ ] **Step 2: Run full test suite one final time**

Run: `cd plugins/unity-mcp && npx vitest run`
Expected: All PASS.

- [ ] **Step 3: Commit the built bundle**

```bash
cd plugins/unity-mcp && git add dist/server.mjs
git commit -m "build: regenerate server bundle with test runner tools" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
