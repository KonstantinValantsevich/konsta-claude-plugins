# Unity Recompile Hook — TypeScript Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the 1190-line monolithic `unity-recompile.sh` bash script as a modular TypeScript project, extracting the embedded C# bridge to a standalone file.

**Architecture:** The shell script becomes a thin wrapper (`exec npx --yes tsx src/index.ts`) that delegates all logic to TypeScript. The codebase is split into focused modules: project detection, change detection, bridge IPC, compilation triggers, and linting. The embedded ~490-line C# bridge is extracted to `templates/ClaudeRecompileBridge.cs`.

**Tech Stack:** TypeScript, tsx (zero-config execution), Vitest, Node.js fs/child_process APIs

---

### Task 1: Project Scaffolding

**Files:**
- Create: `plugins/unity-recompile/package.json`
- Create: `plugins/unity-recompile/tsconfig.json`
- Create: `plugins/unity-recompile/vitest.config.ts`

**Step 1: Create package.json**

```json
{
  "name": "unity-recompile",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts", "__tests__/**/*.ts"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
  },
});
```

**Step 4: Install dependencies**

Run: `cd plugins/unity-recompile && npm install`
Expected: `node_modules` created, lock file generated

**Step 5: Commit**

```bash
git add plugins/unity-recompile/package.json plugins/unity-recompile/tsconfig.json plugins/unity-recompile/vitest.config.ts plugins/unity-recompile/package-lock.json
git commit -m "feat(unity-recompile): scaffold TypeScript project with tsx and vitest"
```

---

### Task 2: Extract C# Bridge Template

**Files:**
- Create: `plugins/unity-recompile/templates/ClaudeRecompileBridge.cs`

**Step 1: Extract the C# source**

Copy the C# code from the bash script's `bridge_source_template()` function (lines 290–780 of `unity-recompile.sh`) verbatim into a new standalone file. This is the content between the `cat <<'CS_EOF'` and `CS_EOF` delimiters — everything from `// ClaudeRecompileBridge Version: 3` through the closing `}`.

The file must be byte-identical to what the bash function outputs so that `ensure_bridge_installed` won't detect a change on the first run after migration.

**Step 2: Verify extraction**

Run: `diff <(cd plugins/unity-recompile && bash -c 'source hooks/unity-recompile.sh 2>/dev/null; bridge_source_template') templates/ClaudeRecompileBridge.cs`

This may not work cleanly due to the script's `set -euo pipefail` — an alternative verification:

Run: `sed -n '290,780p' plugins/unity-recompile/hooks/unity-recompile.sh | diff - plugins/unity-recompile/templates/ClaudeRecompileBridge.cs`
Expected: Files are identical (exit 0)

**Step 3: Commit**

```bash
git add plugins/unity-recompile/templates/ClaudeRecompileBridge.cs
git commit -m "feat(unity-recompile): extract C# bridge template to standalone file"
```

---

### Task 3: Config Module

**Files:**
- Create: `plugins/unity-recompile/src/config.ts`

**Step 1: Create config.ts with all constants**

```typescript
import path from "node:path";
import os from "node:os";

// Bridge protocol
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = "3";

// Timeouts (milliseconds)
export const POLL_INTERVAL_MS = 500;
export const BRIDGE_READY_TIMEOUT_MS = 120_000;
export const BRIDGE_STATUS_TIMEOUT_MS = 120_000;
export const BRIDGE_BUSY_RETRY_DELAY_MS = 1_000;
export const BRIDGE_MAX_BUSY_RETRIES = 1;

// Paths
export const CACHE_DIR = path.join(os.homedir(), ".claude", "cache", "unity-recompile");
export const MARKER_DIR = path.join(CACHE_DIR, "markers");

// Bridge paths (relative to project root)
export const BRIDGE_ASSET_DIR = "Assets/Recompile Hook";
export const BRIDGE_EDITOR_DIR = "Assets/Recompile Hook/Editor";
export const BRIDGE_CS_FILENAME = "ClaudeRecompileBridge.cs";
export const BRIDGE_IPC_DIRNAME = "Library/ClaudeHookIPC";
export const BRIDGE_REQUEST_FILENAME = "request.json";
export const BRIDGE_READY_FILENAME = "bridge-ready.json";

// Git exclude patterns
export const GIT_EXCLUDE_PATTERNS = [
  "/Assets/Recompile Hook/",
  "/Assets/Recompile Hook.meta",
];

/** Resolve bridge paths for a given project root */
export function bridgePaths(projectPath: string) {
  const ipcDir = path.join(projectPath, BRIDGE_IPC_DIRNAME);
  return {
    bridgeRootDir: path.join(projectPath, BRIDGE_ASSET_DIR),
    bridgeEditorDir: path.join(projectPath, BRIDGE_EDITOR_DIR),
    bridgeFile: path.join(projectPath, BRIDGE_EDITOR_DIR, BRIDGE_CS_FILENAME),
    ipcDir,
    requestFile: path.join(ipcDir, BRIDGE_REQUEST_FILENAME),
    readyFile: path.join(ipcDir, BRIDGE_READY_FILENAME),
    statusFile: (requestId: string) =>
      path.join(ipcDir, `status-${requestId}.json`),
  };
}
```

**Step 2: Commit**

```bash
git add plugins/unity-recompile/src/config.ts
git commit -m "feat(unity-recompile): add config module with constants and path helpers"
```

---

### Task 4: Logger Module

**Files:**
- Create: `plugins/unity-recompile/src/logger.ts`

**Step 1: Create logger.ts**

```typescript
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "./config.js";

const LOG_FILE = path.join(CACHE_DIR, "unity-recompile.log");

export function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Logging failures are non-fatal
  }
}
```

**Step 2: Commit**

```bash
git add plugins/unity-recompile/src/logger.ts
git commit -m "feat(unity-recompile): add debug logger module"
```

---

### Task 5: Bridge Types

**Files:**
- Create: `plugins/unity-recompile/src/bridge/types.ts`

**Step 1: Create types.ts with IPC interfaces**

```typescript
export interface BridgeRequest {
  protocolVersion: number;
  requestId: string;
  requestedAtUnixMs: number;
  projectPath: string;
  action: "recompile" | "bootstrap_handshake";
  reason: string;
  source: string;
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
    | "timeout";
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  didCompile: boolean;
  isSuccess: boolean;
  errors: CompileError[];
  summary: string;
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

**Step 2: Commit**

```bash
git add plugins/unity-recompile/src/bridge/types.ts
git commit -m "feat(unity-recompile): add bridge IPC type definitions"
```

---

### Task 6: Project Detection (TDD)

**Files:**
- Create: `plugins/unity-recompile/__tests__/project/detect.test.ts`
- Create: `plugins/unity-recompile/src/project/detect.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectUnityProject } from "../../src/project/detect.js";

describe("detectUnityProject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-detect-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns project root when cwd is the project root", () => {
    fs.mkdirSync(path.join(tmpDir, "Assets"));
    fs.mkdirSync(path.join(tmpDir, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );

    expect(detectUnityProject(tmpDir)).toBe(tmpDir);
  });

  it("returns project root when cwd is a nested subdirectory", () => {
    fs.mkdirSync(path.join(tmpDir, "Assets"));
    fs.mkdirSync(path.join(tmpDir, "ProjectSettings"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );
    const nested = path.join(tmpDir, "Assets", "Scripts", "Player");
    fs.mkdirSync(nested, { recursive: true });

    expect(detectUnityProject(nested)).toBe(tmpDir);
  });

  it("returns null when not inside a Unity project", () => {
    expect(detectUnityProject(tmpDir)).toBeNull();
  });

  it("returns null when Assets exists but ProjectVersion.txt is missing", () => {
    fs.mkdirSync(path.join(tmpDir, "Assets"));

    expect(detectUnityProject(tmpDir)).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/project/detect.test.ts`
Expected: FAIL — module not found

**Step 3: Implement detect.ts**

```typescript
import fs from "node:fs";
import path from "node:path";

/**
 * Walk up from `cwd` to find the nearest Unity project root.
 * A Unity project has both `Assets/` and `ProjectSettings/ProjectVersion.txt`.
 * Returns the project root path, or null if not found.
 */
export function detectUnityProject(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    if (
      fs.existsSync(path.join(dir, "Assets")) &&
      fs.existsSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/project/detect.test.ts`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add plugins/unity-recompile/src/project/detect.ts plugins/unity-recompile/__tests__/project/detect.test.ts
git commit -m "feat(unity-recompile): add Unity project detection with tests"
```

---

### Task 7: Change Detection (TDD)

**Files:**
- Create: `plugins/unity-recompile/__tests__/project/changes.test.ts`
- Create: `plugins/unity-recompile/src/project/changes.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../../src/project/changes.js";

describe("change detection", () => {
  let tmpDir: string;
  let assetsDir: string;
  let markerDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-changes-"));
    assetsDir = path.join(tmpDir, "Assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    markerDir = path.join(tmpDir, "markers");
    fs.mkdirSync(markerDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getMarkerPath", () => {
    it("returns a deterministic path based on project path", () => {
      const p1 = getMarkerPath("/some/project", markerDir);
      const p2 = getMarkerPath("/some/project", markerDir);
      expect(p1).toBe(p2);
    });

    it("returns different paths for different projects", () => {
      const p1 = getMarkerPath("/project/a", markerDir);
      const p2 = getMarkerPath("/project/b", markerDir);
      expect(p1).not.toBe(p2);
    });
  });

  describe("hasChangedCsFiles", () => {
    it("returns true when .cs files are newer than marker", () => {
      const markerPath = path.join(markerDir, "test-marker");
      // Create marker with old timestamp
      fs.writeFileSync(markerPath, "");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(markerPath, past, past);

      // Create a .cs file (will have current mtime)
      fs.writeFileSync(path.join(assetsDir, "Test.cs"), "class Test {}");

      expect(hasChangedCsFiles(tmpDir, markerPath)).toBe(true);
    });

    it("returns false when no .cs files are newer than marker", () => {
      const markerPath = path.join(markerDir, "test-marker");
      // Create .cs file first
      fs.writeFileSync(path.join(assetsDir, "Test.cs"), "class Test {}");

      // Create marker after (will have newer mtime)
      // Small delay to ensure different mtime
      const future = new Date(Date.now() + 60_000);
      fs.writeFileSync(markerPath, "");
      fs.utimesSync(markerPath, future, future);

      expect(hasChangedCsFiles(tmpDir, markerPath)).toBe(false);
    });

    it("returns false when no .cs files exist", () => {
      const markerPath = path.join(markerDir, "test-marker");
      const past = new Date(Date.now() - 60_000);
      fs.writeFileSync(markerPath, "");
      fs.utimesSync(markerPath, past, past);

      expect(hasChangedCsFiles(tmpDir, markerPath)).toBe(false);
    });
  });

  describe("touchMarker", () => {
    it("creates marker file if it does not exist", () => {
      const markerPath = path.join(markerDir, "new-marker");
      touchMarker(markerPath);
      expect(fs.existsSync(markerPath)).toBe(true);
    });

    it("updates mtime of existing marker", () => {
      const markerPath = path.join(markerDir, "old-marker");
      fs.writeFileSync(markerPath, "");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(markerPath, past, past);

      const oldMtime = fs.statSync(markerPath).mtimeMs;
      touchMarker(markerPath);
      const newMtime = fs.statSync(markerPath).mtimeMs;

      expect(newMtime).toBeGreaterThan(oldMtime);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/project/changes.test.ts`
Expected: FAIL — module not found

**Step 3: Implement changes.ts**

```typescript
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MARKER_DIR } from "../config.js";

/** Get the marker file path for a project (MD5 hash of project path). */
export function getMarkerPath(
  projectPath: string,
  markerDir: string = MARKER_DIR,
): string {
  const hash = crypto.createHash("md5").update(projectPath).digest("hex");
  return path.join(markerDir, `recompile-${hash}`);
}

/**
 * Ensure the marker file exists. If it doesn't, create it with epoch mtime
 * so that all .cs files will be considered changed on first run.
 */
export function ensureMarker(markerPath: string): void {
  if (!fs.existsSync(markerPath)) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
    const epoch = new Date(0);
    fs.utimesSync(markerPath, epoch, epoch);
  }
}

/**
 * Check if any .cs files under Assets/ are newer than the marker file.
 * Uses `find -newer` for performance (same approach as the bash script).
 */
export function hasChangedCsFiles(
  projectPath: string,
  markerPath: string,
): boolean {
  try {
    const result = execSync(
      `find "${path.join(projectPath, "Assets")}" -name "*.cs" -newer "${markerPath}" -print -quit 2>/dev/null`,
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

/** Update marker mtime to now (marks recompilation as attempted). */
export function touchMarker(markerPath: string): void {
  if (!fs.existsSync(markerPath)) {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
  }
  const now = new Date();
  fs.utimesSync(markerPath, now, now);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/project/changes.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add plugins/unity-recompile/src/project/changes.ts plugins/unity-recompile/__tests__/project/changes.test.ts
git commit -m "feat(unity-recompile): add marker-based change detection with tests"
```

---

### Task 8: Bridge Install (TDD)

**Files:**
- Create: `plugins/unity-recompile/__tests__/bridge/install.test.ts`
- Create: `plugins/unity-recompile/src/bridge/install.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureBridgeInstalled } from "../../src/bridge/install.js";

describe("ensureBridgeInstalled", () => {
  let tmpProject: string;
  let bridgeFile: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "unity-bridge-"));
    bridgeFile = path.join(
      tmpProject,
      "Assets",
      "Recompile Hook",
      "Editor",
      "ClaudeRecompileBridge.cs",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  it("installs bridge file when it does not exist", () => {
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(true);
    expect(fs.existsSync(bridgeFile)).toBe(true);
    expect(fs.readFileSync(bridgeFile, "utf-8")).toContain(
      "ClaudeRecompileBridge",
    );
  });

  it("does not overwrite when bridge is already up to date", () => {
    // First install
    ensureBridgeInstalled(tmpProject);
    const firstMtime = fs.statSync(bridgeFile).mtimeMs;

    // Second install — should not change
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(false);
  });

  it("overwrites when bridge content differs", () => {
    // Install first
    ensureBridgeInstalled(tmpProject);

    // Corrupt the file
    fs.writeFileSync(bridgeFile, "// corrupted");

    // Re-install should detect change
    const result = ensureBridgeInstalled(tmpProject);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(bridgeFile, "utf-8")).toContain(
      "ClaudeRecompileBridge",
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/bridge/install.test.ts`
Expected: FAIL — module not found

**Step 3: Implement install.ts**

```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { bridgePaths, GIT_EXCLUDE_PATTERNS } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "templates",
  "ClaudeRecompileBridge.cs",
);

/**
 * Ensure the bridge C# file is installed and up-to-date in the Unity project.
 * Returns whether the file was changed (installed or updated).
 */
export function ensureBridgeInstalled(projectPath: string): {
  changed: boolean;
} {
  const paths = bridgePaths(projectPath);
  const templateContent = fs.readFileSync(TEMPLATE_PATH, "utf-8");

  fs.mkdirSync(paths.bridgeEditorDir, { recursive: true });

  if (fs.existsSync(paths.bridgeFile)) {
    const existing = fs.readFileSync(paths.bridgeFile, "utf-8");
    if (existing === templateContent) {
      log("Bridge already up to date");
      return { changed: false };
    }
  }

  // Atomic write: tmp file + rename
  const tmpFile = paths.bridgeFile + ".tmp";
  fs.writeFileSync(tmpFile, templateContent);
  fs.renameSync(tmpFile, paths.bridgeFile);
  log(`Bridge installed/updated: ${paths.bridgeFile}`);
  return { changed: true };
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
        log(`Bridge exclude: added ${pattern}`);
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

**Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/bridge/install.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add plugins/unity-recompile/src/bridge/install.ts plugins/unity-recompile/__tests__/bridge/install.test.ts
git commit -m "feat(unity-recompile): add bridge install and git exclude with tests"
```

---

### Task 9: Bridge IPC (TDD)

**Files:**
- Create: `plugins/unity-recompile/__tests__/bridge/ipc.test.ts`
- Create: `plugins/unity-recompile/src/bridge/ipc.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateRequestId,
  writeBridgeRequest,
  readBridgeStatus,
  parseBridgeStatusToResult,
} from "../../src/bridge/ipc.js";
import type { BridgeStatus } from "../../src/bridge/types.js";

describe("bridge IPC", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-ipc-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("generateRequestId", () => {
    it("returns a non-empty string", () => {
      const id = generateRequestId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("returns unique IDs on consecutive calls", () => {
      const a = generateRequestId();
      const b = generateRequestId();
      expect(a).not.toBe(b);
    });
  });

  describe("writeBridgeRequest", () => {
    it("writes valid JSON to the request file path", () => {
      const requestFile = path.join(tmpDir, "request.json");
      writeBridgeRequest(requestFile, {
        protocolVersion: 1,
        requestId: "test-123",
        requestedAtUnixMs: Date.now(),
        projectPath: "/test/project",
        action: "recompile",
        reason: "test",
        source: "test",
      });

      expect(fs.existsSync(requestFile)).toBe(true);
      const content = JSON.parse(fs.readFileSync(requestFile, "utf-8"));
      expect(content.requestId).toBe("test-123");
      expect(content.action).toBe("recompile");
    });
  });

  describe("readBridgeStatus", () => {
    it("returns null when file does not exist", () => {
      const result = readBridgeStatus(path.join(tmpDir, "nope.json"));
      expect(result).toBeNull();
    });

    it("parses valid status JSON", () => {
      const statusPath = path.join(tmpDir, "status.json");
      const status: BridgeStatus = {
        protocolVersion: 1,
        requestId: "test-123",
        bridgeVersion: "3",
        projectPath: "/test",
        state: "completed",
        createdAtUnixMs: Date.now(),
        updatedAtUnixMs: Date.now(),
        didCompile: true,
        isSuccess: true,
        errors: [],
        summary: "OK",
      };
      fs.writeFileSync(statusPath, JSON.stringify(status));
      expect(readBridgeStatus(statusPath)).toEqual(status);
    });
  });

  describe("parseBridgeStatusToResult", () => {
    it("returns success for completed status with isSuccess=true", () => {
      const status: BridgeStatus = {
        protocolVersion: 1,
        requestId: "x",
        bridgeVersion: "3",
        projectPath: "/p",
        state: "completed",
        createdAtUnixMs: 0,
        updatedAtUnixMs: 0,
        didCompile: true,
        isSuccess: true,
        errors: [],
        summary: "OK",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("returns failure with formatted errors for failed status", () => {
      const status: BridgeStatus = {
        protocolVersion: 1,
        requestId: "x",
        bridgeVersion: "3",
        projectPath: "/p",
        state: "failed",
        createdAtUnixMs: 0,
        updatedAtUnixMs: 0,
        didCompile: true,
        isSuccess: false,
        errors: [
          {
            assembly: "Assembly-CSharp",
            file: "Assets/Test.cs",
            line: 10,
            column: 5,
            message: "error CS1001: ; expected",
            type: "Error",
          },
        ],
        summary: "Compilation failed",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it("returns failure for busy state", () => {
      const status: BridgeStatus = {
        protocolVersion: 1,
        requestId: "x",
        bridgeVersion: "3",
        projectPath: "/p",
        state: "busy",
        createdAtUnixMs: 0,
        updatedAtUnixMs: 0,
        didCompile: false,
        isSuccess: false,
        errors: [],
        summary: "Bridge is busy",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("busy");
    });

    it("returns failure for version mismatch", () => {
      const status: BridgeStatus = {
        protocolVersion: 99,
        requestId: "x",
        bridgeVersion: "99",
        projectPath: "/p",
        state: "completed",
        createdAtUnixMs: 0,
        updatedAtUnixMs: 0,
        didCompile: true,
        isSuccess: true,
        errors: [],
        summary: "OK",
      };
      const result = parseBridgeStatusToResult(status);
      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain("mismatch");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/bridge/ipc.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ipc.ts**

```typescript
import crypto from "node:crypto";
import fs from "node:fs";
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  POLL_INTERVAL_MS,
} from "../config.js";
import { log } from "../logger.js";
import type { BridgeRequest, BridgeStatus, CompileResult } from "./types.js";

/** Generate a unique request ID: `{unixSecs}-{pid}-{randomHex}` */
export function generateRequestId(): string {
  const secs = Math.floor(Date.now() / 1000);
  const rnd = crypto.randomBytes(4).toString("hex");
  return `${secs}-${process.pid}-${rnd}`;
}

/** Write a bridge request JSON file atomically. */
export function writeBridgeRequest(
  requestFilePath: string,
  request: BridgeRequest,
): void {
  const tmpPath = requestFilePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(request));
  fs.renameSync(tmpPath, requestFilePath);
  // Touch to trigger FileSystemWatcher Changed event (rename alone can be unreliable)
  const now = new Date();
  fs.utimesSync(requestFilePath, now, now);
  log(`Wrote bridge request: action=${request.action} requestId=${request.requestId}`);
}

/** Read and parse a bridge status JSON file. Returns null if missing or invalid. */
export function readBridgeStatus(statusPath: string): BridgeStatus | null {
  try {
    if (!fs.existsSync(statusPath)) return null;
    const content = fs.readFileSync(statusPath, "utf-8");
    return JSON.parse(content) as BridgeStatus;
  } catch {
    return null;
  }
}

/** Read and parse the bridge-ready JSON file. */
export function readBridgeReady(
  readyPath: string,
): { protocolVersion: number; bridgeVersion: string; projectPath: string } | null {
  try {
    if (!fs.existsSync(readyPath)) return null;
    const content = fs.readFileSync(readyPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Check if bridge-ready file matches the expected project and version. */
export function bridgeReadyMatchesProject(
  readyPath: string,
  projectPath: string,
): boolean {
  const ready = readBridgeReady(readyPath);
  if (!ready) return false;
  return (
    ready.projectPath === projectPath &&
    ready.bridgeVersion === BRIDGE_VERSION &&
    ready.protocolVersion === BRIDGE_PROTOCOL_VERSION
  );
}

/** Convert a BridgeStatus to a CompileResult with formatted error strings. */
export function parseBridgeStatusToResult(status: BridgeStatus): CompileResult {
  // Version mismatch
  if (
    status.bridgeVersion !== BRIDGE_VERSION ||
    status.protocolVersion !== BRIDGE_PROTOCOL_VERSION
  ) {
    return {
      success: false,
      didCompile: false,
      errors: [
        `Bridge status version mismatch (got version=${status.bridgeVersion} protocol=${status.protocolVersion})`,
      ],
    };
  }

  // Busy state
  if (status.state === "busy") {
    return {
      success: false,
      didCompile: false,
      errors: [status.summary || "Bridge is busy"],
    };
  }

  // Bridge error or timeout
  if (status.state === "bridge_error" || status.state === "timeout") {
    return {
      success: false,
      didCompile: false,
      errors: [status.summary || "Bridge error"],
    };
  }

  // Success
  if (status.isSuccess) {
    return { success: true, didCompile: status.didCompile, errors: [] };
  }

  // Failure with compile errors
  const errors = (status.errors || []).map((e) => {
    if (e.message?.startsWith(`${e.file}(`)) {
      return e.message;
    }
    if (e.file) {
      return `${e.file}(${e.line},${e.column}): ${e.message}`;
    }
    return e.message;
  });
  if (errors.length === 0) {
    errors.push(status.summary || "Unity compilation failed");
  }
  return { success: false, didCompile: status.didCompile, errors };
}

/** Sleep for a given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for the bridge-ready file to match the expected project.
 * Returns true if ready within timeout, false on timeout.
 */
export async function waitForBridgeReady(
  readyPath: string,
  projectPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bridgeReadyMatchesProject(readyPath, projectPath)) {
      log("Bridge ready file detected for project");
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log("Timed out waiting for bridge-ready.json");
  return false;
}

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "bridge_error",
  "busy",
  "timeout",
]);

/**
 * Poll for a bridge status file with the matching request ID and terminal state.
 * Returns the BridgeStatus or null on timeout.
 */
export async function waitForBridgeStatus(
  statusPath: string,
  requestId: string,
  timeoutMs: number,
): Promise<BridgeStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readBridgeStatus(statusPath);
    if (status && status.requestId === requestId) {
      if (
        status.bridgeVersion !== BRIDGE_VERSION ||
        status.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      ) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (TERMINAL_STATES.has(status.state)) {
        log(`Bridge status final: requestId=${requestId} state=${status.state}`);
        return status;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log(`Timed out waiting for bridge status: requestId=${requestId}`);
  return null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/bridge/ipc.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add plugins/unity-recompile/src/bridge/ipc.ts plugins/unity-recompile/__tests__/bridge/ipc.test.ts
git commit -m "feat(unity-recompile): add bridge IPC read/write/poll with tests"
```

---

### Task 10: AppleScript Trigger

**Files:**
- Create: `plugins/unity-recompile/src/compile/applescript.ts`

No tests for this module — it shells out to `osascript` and interacts with the macOS window manager, which can't be unit tested.

**Step 1: Implement applescript.ts**

```typescript
import { execSync } from "node:child_process";
import { log } from "../logger.js";

/** Find the PID of the Unity Editor process for a given project (excluding batchMode). */
export function findUnityPid(projectPath: string): string | null {
  try {
    const output = execSync(
      `ps aux | grep '[U]nity' | grep "${projectPath}" | grep -v batchMode | awk '{print $2}' | head -1`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Check if Unity Editor is running for the given project. */
export function unityIsRunning(projectPath: string): boolean {
  return findUnityPid(projectPath) !== null;
}

/**
 * Trigger Unity Editor refresh via AppleScript (Cmd+R).
 * Returns the previous frontmost app name (for restoring focus), or null on failure.
 */
export function triggerRefreshAppleScript(projectPath: string): string | null {
  const pid = findUnityPid(projectPath);
  if (!pid) {
    log("AppleScript: Could not find Unity process");
    return null;
  }

  try {
    const result = execSync(
      `osascript -e '
        set previousApp to (path to frontmost application as text)
        tell application "System Events"
          set frontmost of (first process whose unix id is ${pid}) to true
        end tell
        delay 0.3
        tell application "System Events"
          keystroke "r" using command down
        end tell
        return previousApp
      '`,
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    log("Triggered editor refresh via AppleScript");
    return result || null;
  } catch (err) {
    log(`AppleScript trigger failed: ${err}`);
    return null;
  }
}

/** Switch focus back to a previously frontmost application. */
export function switchBackToApp(appName: string): void {
  try {
    execSync(`osascript -e 'tell application "${appName}" to activate'`, {
      timeout: 5_000,
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Trigger editor refresh and restore the previous app in focus.
 */
export function triggerEditorRefreshOnly(projectPath: string): boolean {
  const previousApp = triggerRefreshAppleScript(projectPath);
  if (previousApp) {
    switchBackToApp(previousApp);
  }
  log("Triggered editor refresh (trigger-only path)");
  return true;
}
```

**Step 2: Commit**

```bash
git add plugins/unity-recompile/src/compile/applescript.ts
git commit -m "feat(unity-recompile): add AppleScript Unity refresh trigger"
```

---

### Task 11: CLI Fallback

**Files:**
- Create: `plugins/unity-recompile/src/compile/cli-fallback.ts`

No tests — shells out to Unity CLI binary.

**Step 1: Implement cli-fallback.ts**

```typescript
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import type { CompileResult } from "../bridge/types.js";

/**
 * Read the Unity version from ProjectSettings/ProjectVersion.txt.
 * Returns null if not found.
 */
function readUnityVersion(projectPath: string): string | null {
  const versionFile = path.join(
    projectPath,
    "ProjectSettings",
    "ProjectVersion.txt",
  );
  try {
    const content = fs.readFileSync(versionFile, "utf-8");
    const match = content.match(/m_EditorVersion:\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run Unity in batch mode to refresh/compile the project.
 * Used when Unity Editor is not running.
 */
export function runCliFallback(projectPath: string): CompileResult {
  const version = readUnityVersion(projectPath);
  if (!version) {
    return {
      success: false,
      didCompile: false,
      errors: ["Could not detect Unity version from ProjectVersion.txt"],
    };
  }

  const unityPath = `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`;
  if (!fs.existsSync(unityPath)) {
    return {
      success: false,
      didCompile: false,
      errors: [
        `Unity not found at: ${unityPath}`,
        `Please ensure Unity ${version} is installed via Unity Hub`,
      ],
    };
  }

  process.stderr.write(
    "Unity not running. Starting batch compilation (this may take a moment)...\n",
  );
  log("CLI fallback: starting batch compilation");

  try {
    const output = execSync(
      `"${unityPath}" -batchmode -projectPath "${projectPath}" -executeMethod UnityEditor.AssetDatabase.Refresh -logFile - -quit 2>&1 | grep "error CS" || true`,
      { encoding: "utf-8", timeout: 300_000 },
    ).trim();

    const errors = output ? output.split("\n").filter(Boolean) : [];
    log(
      `CLI fallback: ${errors.length > 0 ? `${errors.length} errors` : "success"}`,
    );
    return {
      success: errors.length === 0,
      didCompile: true,
      errors,
    };
  } catch (err) {
    log(`CLI fallback failed: ${err}`);
    return {
      success: false,
      didCompile: false,
      errors: [`Batch compilation failed: ${err}`],
    };
  }
}
```

**Step 2: Commit**

```bash
git add plugins/unity-recompile/src/compile/cli-fallback.ts
git commit -m "feat(unity-recompile): add CLI batch mode fallback compilation"
```

---

### Task 12: Bridge Orchestration (TDD)

**Files:**
- Create: `plugins/unity-recompile/__tests__/bridge/orchestrate.test.ts`
- Create: `plugins/unity-recompile/src/bridge/orchestrate.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We test the lower-level bridgeRequestAndWait function with a simulated
// bridge response (write a status file during polling).

describe("bridge orchestration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-orch-"));
    fs.mkdirSync(path.join(tmpDir, "Library", "ClaudeHookIPC"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bridgeRequestAndWait resolves when status file appears", async () => {
    // Dynamically import to allow vi.mock if needed in future
    const { bridgeRequestAndWait } = await import(
      "../../src/bridge/orchestrate.js"
    );

    const ipcDir = path.join(tmpDir, "Library", "ClaudeHookIPC");

    // Simulate bridge: write status file after a short delay
    const resultPromise = bridgeRequestAndWait(
      tmpDir,
      "recompile",
      5_000, // short timeout for test
    );

    // Read the request file to get the request ID
    await new Promise((r) => setTimeout(r, 200));
    const requestFile = path.join(ipcDir, "request.json");
    const request = JSON.parse(fs.readFileSync(requestFile, "utf-8"));

    // Simulate bridge response
    const statusFile = path.join(
      ipcDir,
      `status-${request.requestId}.json`,
    );
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        bridgeVersion: "3",
        projectPath: tmpDir,
        state: "completed",
        createdAtUnixMs: Date.now(),
        updatedAtUnixMs: Date.now(),
        didCompile: true,
        isSuccess: true,
        errors: [],
        summary: "OK",
      }),
    );

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("bridgeRequestAndWait returns failure on timeout", async () => {
    const { bridgeRequestAndWait } = await import(
      "../../src/bridge/orchestrate.js"
    );

    // Very short timeout, no status file will appear
    const result = await bridgeRequestAndWait(tmpDir, "recompile", 1_000);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Timed out");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/bridge/orchestrate.test.ts`
Expected: FAIL — module not found

**Step 3: Implement orchestrate.ts**

```typescript
import fs from "node:fs";
import {
  bridgePaths,
  BRIDGE_BUSY_RETRY_DELAY_MS,
  BRIDGE_MAX_BUSY_RETRIES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_READY_TIMEOUT_MS,
  BRIDGE_STATUS_TIMEOUT_MS,
} from "../config.js";
import { log } from "../logger.js";
import {
  triggerEditorRefreshOnly,
  unityIsRunning,
} from "../compile/applescript.js";
import { runCliFallback } from "../compile/cli-fallback.js";
import type { BridgeRequest, CompileResult } from "./types.js";
import {
  bridgeReadyMatchesProject,
  generateRequestId,
  parseBridgeStatusToResult,
  sleep,
  waitForBridgeReady,
  waitForBridgeStatus,
  writeBridgeRequest,
} from "./ipc.js";

/**
 * Send a bridge request and wait for the status response.
 * Handles busy retries.
 */
export async function bridgeRequestAndWait(
  projectPath: string,
  action: "recompile" | "bootstrap_handshake",
  timeoutMs: number,
): Promise<CompileResult> {
  const paths = bridgePaths(projectPath);
  let attempt = 0;

  while (true) {
    const requestId = generateRequestId();
    const statusPath = paths.statusFile(requestId);

    // Clean up any stale status file
    try {
      fs.unlinkSync(statusPath);
    } catch {
      // Doesn't exist, fine
    }

    const request: BridgeRequest = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId,
      requestedAtUnixMs: Date.now(),
      projectPath,
      action,
      reason: "claude-stop-hook",
      source: "unity-recompile-ts",
    };

    fs.mkdirSync(paths.ipcDir, { recursive: true });
    writeBridgeRequest(paths.requestFile, request);

    const status = await waitForBridgeStatus(
      statusPath,
      requestId,
      timeoutMs,
    );
    if (!status) {
      return {
        success: false,
        didCompile: false,
        errors: [`Timed out waiting for bridge status (${action})`],
      };
    }

    const result = parseBridgeStatusToResult(status);

    // Retry on busy
    if (status.state === "busy" && attempt < BRIDGE_MAX_BUSY_RETRIES) {
      attempt++;
      log(`Bridge busy, retrying action=${action} attempt=${attempt}`);
      await sleep(BRIDGE_BUSY_RETRY_DELAY_MS);
      continue;
    }

    return result;
  }
}

/**
 * Bootstrap flow: trigger refresh via AppleScript, wait for bridge ready,
 * then send handshake + recompile.
 */
export async function runBridgeBootstrapAndRecompile(
  projectPath: string,
): Promise<CompileResult> {
  log("Bridge bootstrap flow starting");
  const paths = bridgePaths(projectPath);

  if (!unityIsRunning(projectPath)) {
    log("Bridge bootstrap unavailable: Unity editor not running");
    return {
      success: false,
      didCompile: false,
      errors: ["Unity Editor is not running, cannot bootstrap bridge IPC"],
    };
  }

  triggerEditorRefreshOnly(projectPath);

  const ready = await waitForBridgeReady(
    paths.readyFile,
    projectPath,
    BRIDGE_READY_TIMEOUT_MS,
  );
  if (!ready) {
    return {
      success: false,
      didCompile: false,
      errors: ["Bridge did not become ready after bootstrap refresh"],
    };
  }

  // Handshake
  const handshake = await bridgeRequestAndWait(
    projectPath,
    "bootstrap_handshake",
    BRIDGE_READY_TIMEOUT_MS,
  );
  if (!handshake.success) return handshake;

  log(
    "Bridge bootstrap handshake succeeded, requesting authoritative recompile",
  );
  return bridgeRequestAndWait(
    projectPath,
    "recompile",
    BRIDGE_STATUS_TIMEOUT_MS,
  );
}

/**
 * Direct recompile flow: bridge is already ready, send recompile directly.
 */
export async function runBridgeRecompileDirect(
  projectPath: string,
): Promise<CompileResult | null> {
  if (!unityIsRunning(projectPath)) return null;

  const paths = bridgePaths(projectPath);
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) return null;

  log("Bridge direct recompile flow");
  return bridgeRequestAndWait(
    projectPath,
    "recompile",
    BRIDGE_STATUS_TIMEOUT_MS,
  );
}

/**
 * Top-level orchestration: pick compilation strategy based on state.
 */
export async function orchestrateRecompile(
  projectPath: string,
  bridgeChangedThisRun: boolean,
): Promise<CompileResult> {
  if (unityIsRunning(projectPath)) {
    log("Unity IS running");

    if (bridgeChangedThisRun) {
      log("Bridge changed this run; using bootstrap flow");
      return runBridgeBootstrapAndRecompile(projectPath);
    }

    // Try direct first
    const direct = await runBridgeRecompileDirect(projectPath);
    if (direct) {
      log("Bridge ready; used direct bridge path");
      return direct;
    }

    // Fall back to bootstrap
    log("Bridge not ready; using bootstrap flow");
    return runBridgeBootstrapAndRecompile(projectPath);
  }

  log("Unity NOT running, using CLI fallback");
  return runCliFallback(projectPath);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/bridge/orchestrate.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add plugins/unity-recompile/src/bridge/orchestrate.ts plugins/unity-recompile/__tests__/bridge/orchestrate.test.ts
git commit -m "feat(unity-recompile): add bridge orchestration with request/wait/retry logic"
```

---

### Task 13: Lint Module

**Files:**
- Create: `plugins/unity-recompile/src/lint.ts`

No tests — shells out to `dotnet format` and `git diff`.

**Step 1: Implement lint.ts**

```typescript
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

/**
 * Run `dotnet format` on changed .cs files in the background (fire-and-forget).
 * Groups files by their .csproj and runs formatting in parallel per project.
 */
export function runDotnetFormatLint(projectPath: string): void {
  try {
    execSync("which dotnet", { stdio: "ignore", timeout: 5_000 });
  } catch {
    log("Lint: dotnet not found, skipping");
    return;
  }

  let changedFiles: string;
  try {
    changedFiles = execSync(
      `git -C "${projectPath}" diff HEAD --name-only -- '*.cs'`,
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
  } catch {
    log("Lint: could not get changed files, skipping");
    return;
  }
  if (!changedFiles) {
    log("Lint: no changed .cs files, skipping");
    return;
  }

  // Check for .csproj files
  const csprojs = fs
    .readdirSync(projectPath)
    .filter((f) => f.endsWith(".csproj"));
  if (csprojs.length === 0) {
    log("Lint: no .csproj files found, skipping");
    return;
  }

  // Group files by csproj
  const groups = new Map<string, string[]>();
  for (const file of changedFiles.split("\n").filter(Boolean)) {
    for (const csproj of csprojs) {
      const csprojPath = path.join(projectPath, csproj);
      try {
        const content = fs.readFileSync(csprojPath, "utf-8");
        if (content.includes(`"${file}"`)) {
          if (!groups.has(csproj)) groups.set(csproj, []);
          groups.get(csproj)!.push(file);
          break;
        }
      } catch {
        // Skip unreadable csproj
      }
    }
  }

  if (groups.size === 0) {
    log("Lint: no files matched any .csproj, skipping");
    return;
  }

  const fileCount = changedFiles.split("\n").filter(Boolean).length;
  log(
    `Lint: formatting ${fileCount} file(s) across ${groups.size} project(s)`,
  );

  // Run dotnet format per project in parallel (detached, fire-and-forget)
  for (const [csproj, files] of groups) {
    const includeArg = files.join(",");
    const csprojPath = path.join(projectPath, csproj);
    log(`Lint: dotnet format ${csproj} --include ${includeArg}`);
    const child = spawn(
      "dotnet",
      [
        "format",
        csprojPath,
        "--include",
        includeArg,
        "--severity",
        "warn",
        "--no-restore",
        "--verbosity",
        "quiet",
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  }
}
```

**Step 2: Commit**

```bash
git add plugins/unity-recompile/src/lint.ts
git commit -m "feat(unity-recompile): add background dotnet format lint module"
```

---

### Task 14: Entry Point (index.ts)

**Files:**
- Create: `plugins/unity-recompile/src/index.ts`

**Step 1: Implement index.ts**

```typescript
import fs from "node:fs";
import { MARKER_DIR } from "./config.js";
import { log } from "./logger.js";
import { detectUnityProject } from "./project/detect.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "./project/changes.js";
import { ensureBridgeInstalled, ensureGitExclude } from "./bridge/install.js";
import { bridgePaths } from "./config.js";
import { orchestrateRecompile } from "./bridge/orchestrate.js";
import { runDotnetFormatLint } from "./lint.js";

async function main(): Promise<void> {
  log("=== Hook started ===");

  // Read stdin JSON for cwd
  let cwd = process.cwd();
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    log(`stdin length: ${stdin.length}`);
    if (stdin) {
      const data = JSON.parse(stdin);
      if (data.cwd) {
        cwd = data.cwd;
        log(`cwd: ${cwd}`);
      } else {
        log(`cwd (from PWD): ${cwd}`);
      }
    }
  } catch {
    log(`cwd (from PWD): ${cwd}`);
  }

  // Detect Unity project
  const projectPath = detectUnityProject(cwd);
  if (!projectPath) {
    log(`Not a Unity project: ${cwd}`);
    process.exit(0);
  }
  log(`Unity project: ${projectPath}`);

  // Check skip marker
  const skipMarker = `${projectPath}/.claude/hooks-skip-recompile`;
  if (fs.existsSync(skipMarker)) {
    log("Skipping: project has .claude/hooks-skip-recompile marker");
    process.exit(0);
  }

  // Change detection
  fs.mkdirSync(MARKER_DIR, { recursive: true });
  const markerPath = getMarkerPath(projectPath);
  ensureMarker(markerPath);

  if (!hasChangedCsFiles(projectPath, markerPath)) {
    log("No .cs files changed since last check, exiting");
    process.exit(0);
  }
  log("C# files changed, triggering recompilation");

  // Install bridge
  const paths = bridgePaths(projectPath);
  ensureGitExclude(projectPath);
  fs.mkdirSync(paths.ipcDir, { recursive: true });
  const { changed: bridgeChangedThisRun } =
    ensureBridgeInstalled(projectPath);

  // Orchestrate recompilation
  const result = await orchestrateRecompile(projectPath, bridgeChangedThisRun);

  // Update marker
  touchMarker(markerPath);
  log(`Marker file updated: ${markerPath}`);

  // Output results
  if (result.success) {
    log("SUCCESS: Unity recompilation complete");
    process.stderr.write("Unity compiled successfully\n");
    runDotnetFormatLint(projectPath);
    process.exit(0);
  } else {
    log("FAILED: Unity compilation errors found");
    process.stderr.write("Unity compilation failed:\n\n");
    process.stderr.write(result.errors.join("\n") + "\n\n");
    process.stderr.write("Fix these errors to continue.\n");
    process.exit(2);
  }
}

main().catch((err) => {
  log(`Unhandled error: ${err}`);
  process.stderr.write(`Unity recompile hook error: ${err}\n`);
  process.exit(1);
});
```

**Step 2: Verify it compiles**

Run: `cd plugins/unity-recompile && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add plugins/unity-recompile/src/index.ts
git commit -m "feat(unity-recompile): add main entry point orchestrating full recompile flow"
```

---

### Task 15: Update Shell Wrapper

**Files:**
- Modify: `plugins/unity-recompile/hooks/unity-recompile.sh` (replace entire content)

**Step 1: Replace the shell script with a thin wrapper**

The new `unity-recompile.sh` should be:

```bash
#!/bin/bash
# Unity Recompile Hook — thin wrapper delegating to TypeScript
# See src/index.ts for the actual implementation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx --yes tsx "$SCRIPT_DIR/../src/index.ts"
```

This preserves:
- Same hook entry point
- stdin piped through (exec inherits stdin)
- Exit codes propagated (exec replaces process)

**Step 2: Test the wrapper manually**

Run: `echo '{}' | plugins/unity-recompile/hooks/unity-recompile.sh`
Expected: Exits 0 (assuming not in a Unity project directory). Check `~/.claude/cache/unity-recompile/unity-recompile.log` for `Not a Unity project` message.

**Step 3: Commit**

```bash
git add plugins/unity-recompile/hooks/unity-recompile.sh
git commit -m "feat(unity-recompile): replace bash script with thin tsx wrapper"
```

---

### Task 16: Integration Test

**Files:**
- Create: `plugins/unity-recompile/__tests__/integration/full-flow.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectUnityProject } from "../../src/project/detect.js";
import {
  ensureMarker,
  getMarkerPath,
  hasChangedCsFiles,
  touchMarker,
} from "../../src/project/changes.js";
import { ensureBridgeInstalled } from "../../src/bridge/install.js";
import { bridgePaths } from "../../src/config.js";

describe("integration: full flow simulation", () => {
  let tmpDir: string;
  let markerDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-integ-"));
    markerDir = path.join(tmpDir, "markers");
    fs.mkdirSync(markerDir, { recursive: true });

    // Set up fake Unity project
    fs.mkdirSync(path.join(tmpDir, "project", "Assets", "Scripts"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, "project", "ProjectSettings"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, "project", "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 2022.3.0f1",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects project, finds changes, installs bridge", () => {
    const projectPath = path.join(tmpDir, "project");

    // 1. Detect project from nested dir
    const detected = detectUnityProject(
      path.join(projectPath, "Assets", "Scripts"),
    );
    expect(detected).toBe(projectPath);

    // 2. Set up marker at epoch
    const markerPath = getMarkerPath(projectPath, markerDir);
    ensureMarker(markerPath);

    // 3. Create a .cs file
    fs.writeFileSync(
      path.join(projectPath, "Assets", "Scripts", "Player.cs"),
      "class Player {}",
    );

    // 4. Detect changes
    expect(hasChangedCsFiles(projectPath, markerPath)).toBe(true);

    // 5. Install bridge
    const { changed } = ensureBridgeInstalled(projectPath);
    expect(changed).toBe(true);

    // 6. Verify bridge file exists
    const paths = bridgePaths(projectPath);
    expect(fs.existsSync(paths.bridgeFile)).toBe(true);
    expect(fs.readFileSync(paths.bridgeFile, "utf-8")).toContain(
      "ClaudeRecompileBridge Version: 3",
    );

    // 7. Touch marker
    touchMarker(markerPath);

    // 8. No more changes after marker touched
    // Need to set .cs file mtime to before marker
    const pastCs = new Date(Date.now() - 5_000);
    fs.utimesSync(
      path.join(projectPath, "Assets", "Scripts", "Player.cs"),
      pastCs,
      pastCs,
    );
    expect(hasChangedCsFiles(projectPath, markerPath)).toBe(false);
  });

  it("second bridge install reports no change", () => {
    const projectPath = path.join(tmpDir, "project");
    ensureBridgeInstalled(projectPath);
    const result = ensureBridgeInstalled(projectPath);
    expect(result.changed).toBe(false);
  });
});
```

**Step 2: Run integration test**

Run: `cd plugins/unity-recompile && npx vitest run __tests__/integration/full-flow.test.ts`
Expected: All tests PASS

**Step 3: Run full test suite**

Run: `cd plugins/unity-recompile && npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add plugins/unity-recompile/__tests__/integration/full-flow.test.ts
git commit -m "feat(unity-recompile): add integration test covering full flow"
```

---

### Task 17: Final Verification & Cleanup

**Step 1: Run type check**

Run: `cd plugins/unity-recompile && npx tsc --noEmit`
Expected: No errors

**Step 2: Run full test suite**

Run: `cd plugins/unity-recompile && npx vitest run`
Expected: All tests pass

**Step 3: Verify hooks.json is unchanged**

Run: `cat plugins/unity-recompile/hooks/hooks.json`
Expected: Same content as before (calls `unity-recompile.sh`, which now delegates to tsx)

**Step 4: Verify external behavior**

Run: `echo '{}' | plugins/unity-recompile/hooks/unity-recompile.sh`
Expected: Exit 0, log shows "Not a Unity project"

**Step 5: Add node_modules to .gitignore if needed**

Check if `plugins/unity-recompile/.gitignore` exists; if not, create one with `node_modules/`.

**Step 6: Final commit**

```bash
git add -A plugins/unity-recompile/
git commit -m "chore(unity-recompile): TypeScript rewrite complete — cleanup and verification"
```
