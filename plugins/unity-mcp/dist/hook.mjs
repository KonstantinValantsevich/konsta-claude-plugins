// src/hook/index.ts
import fs10 from "node:fs";

// src/lib/project/detect.ts
import fs from "node:fs";
import path from "node:path";
function detectUnityProject(cwd) {
  let dir = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(dir, "Assets")) && fs.existsSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// src/core/detect.ts
function detectProject(cwd) {
  return detectUnityProject(cwd);
}

// src/core/recompile.ts
import fs8 from "node:fs";

// src/lib/config.ts
import path2 from "node:path";
import os from "node:os";
var BRIDGE_PROTOCOL_VERSION = 1;
var BRIDGE_VERSION = "4";
var POLL_INTERVAL_MS = 500;
var BRIDGE_READY_TIMEOUT_MS = 12e4;
var BRIDGE_STATUS_TIMEOUT_MS = 12e4;
var TEST_STATUS_TIMEOUT_MS = 3e5;
var UNITY_LAUNCH_TIMEOUT_MS = 3e4;
var BRIDGE_READY_LAUNCH_TIMEOUT_MS = 3e5;
var CACHE_DIR = path2.join(os.homedir(), ".claude", "cache", "unity-recompile");
var MARKER_DIR = path2.join(CACHE_DIR, "markers");
var TEST_STORE_DIR = path2.join(CACHE_DIR, "test-runs");
var BRIDGE_ASSET_DIR = "Assets/Claude Bridge";
var BRIDGE_EDITOR_DIR = "Assets/Claude Bridge/Editor";
var BRIDGE_CS_FILES = [
  "ClaudeBridgeBase.cs",
  "ClaudeRecompileHandler.cs",
  "ClaudeTestHandler.cs",
  "ClaudeSearchHandler.cs"
];
var BRIDGE_IPC_DIRNAME = "Library/ClaudeHookIPC";
var BRIDGE_READY_FILENAME = "bridge-ready.json";
var LEGACY_BRIDGE_ASSET_DIR = "Assets/Recompile Hook";
var GIT_EXCLUDE_PATTERNS = [
  "/Assets/Claude Bridge/",
  "/Assets/Claude Bridge.meta"
];
function bridgePaths(projectPath) {
  const ipcDir = path2.join(projectPath, BRIDGE_IPC_DIRNAME);
  return {
    bridgeRootDir: path2.join(projectPath, BRIDGE_ASSET_DIR),
    bridgeEditorDir: path2.join(projectPath, BRIDGE_EDITOR_DIR),
    bridgeFiles: BRIDGE_CS_FILES.map(
      (f) => path2.join(projectPath, BRIDGE_EDITOR_DIR, f)
    ),
    ipcDir,
    requestFile: (requestId) => path2.join(ipcDir, `request-${requestId}.json`),
    readyFile: path2.join(ipcDir, BRIDGE_READY_FILENAME),
    statusFile: (requestId) => path2.join(ipcDir, `status-${requestId}.json`)
  };
}

// src/lib/project/changes.ts
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs2 from "node:fs";
import path3 from "node:path";
function getMarkerPath(projectPath, purpose = "recompile", markerDir = MARKER_DIR) {
  const hash = crypto.createHash("md5").update(projectPath).digest("hex");
  return path3.join(markerDir, `${purpose}-${hash}`);
}
function ensureMarker(markerPath) {
  if (!fs2.existsSync(markerPath)) {
    fs2.mkdirSync(path3.dirname(markerPath), { recursive: true });
    fs2.writeFileSync(markerPath, "");
    const epoch = /* @__PURE__ */ new Date(0);
    fs2.utimesSync(markerPath, epoch, epoch);
  }
}
function hasChangedCsFiles(projectPath, markerPath) {
  try {
    const result = execSync(
      `find "${path3.join(projectPath, "Assets")}" -name "*.cs" -newer "${markerPath}" -print -quit 2>/dev/null`,
      { encoding: "utf-8", timeout: 1e4 }
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}
function touchMarker(markerPath) {
  if (!fs2.existsSync(markerPath)) {
    fs2.mkdirSync(path3.dirname(markerPath), { recursive: true });
    fs2.writeFileSync(markerPath, "");
  }
  const now = /* @__PURE__ */ new Date();
  fs2.utimesSync(markerPath, now, now);
}

// src/lib/bridge/install.ts
import fs4 from "node:fs";
import path5 from "node:path";
import { fileURLToPath } from "node:url";
import { execSync as execSync2 } from "node:child_process";

// src/lib/logger.ts
import fs3 from "node:fs";
import path4 from "node:path";
var LOG_FILE = path4.join(CACHE_DIR, "unity-recompile.log");
function log(message) {
  const timestamp = (/* @__PURE__ */ new Date()).toLocaleTimeString("en-GB", { hour12: false });
  const line = `[${timestamp}] ${message}
`;
  try {
    fs3.mkdirSync(path4.dirname(LOG_FILE), { recursive: true });
    fs3.appendFileSync(LOG_FILE, line);
  } catch {
  }
}

// src/lib/bridge/install.ts
var __dirname = path5.dirname(fileURLToPath(import.meta.url));
function findPackageRoot(startDir) {
  let dir = startDir;
  while (dir !== path5.dirname(dir)) {
    if (fs4.existsSync(path5.join(dir, "package.json"))) return dir;
    dir = path5.dirname(dir);
  }
  return startDir;
}
var TEMPLATES_DIR = path5.join(findPackageRoot(__dirname), "templates");
function ensureBridgeInstalled(projectPath) {
  const paths = bridgePaths(projectPath);
  const legacyDir = path5.join(projectPath, LEGACY_BRIDGE_ASSET_DIR);
  if (fs4.existsSync(legacyDir)) {
    log("Migrating: removing legacy bridge folder " + legacyDir);
    fs4.rmSync(legacyDir, { recursive: true, force: true });
    const legacyMeta = legacyDir + ".meta";
    if (fs4.existsSync(legacyMeta)) fs4.unlinkSync(legacyMeta);
  }
  fs4.mkdirSync(paths.bridgeEditorDir, { recursive: true });
  let anyChanged = false;
  for (const filename of BRIDGE_CS_FILES) {
    const templatePath = path5.join(TEMPLATES_DIR, filename);
    const destPath = path5.join(paths.bridgeEditorDir, filename);
    if (!fs4.existsSync(templatePath)) {
      log("Template not found, skipping: " + filename);
      continue;
    }
    const templateContent = fs4.readFileSync(templatePath, "utf-8");
    if (fs4.existsSync(destPath)) {
      const existing = fs4.readFileSync(destPath, "utf-8");
      if (existing === templateContent) {
        continue;
      }
    }
    const tmpFile = destPath + ".tmp";
    fs4.writeFileSync(tmpFile, templateContent);
    fs4.renameSync(tmpFile, destPath);
    log("Bridge installed/updated: " + destPath);
    anyChanged = true;
  }
  if (!anyChanged) {
    log("All bridge files up to date");
  }
  return { changed: anyChanged };
}
function ensureGitExclude(projectPath) {
  try {
    const gitDir = execSync2("git rev-parse --git-dir", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 5e3
    }).trim();
    if (!gitDir) return;
    const excludeFile = path5.join(projectPath, gitDir, "info", "exclude");
    fs4.mkdirSync(path5.dirname(excludeFile), { recursive: true });
    let content = "";
    try {
      content = fs4.readFileSync(excludeFile, "utf-8");
    } catch {
    }
    let changed = false;
    for (const pattern of GIT_EXCLUDE_PATTERNS) {
      if (!content.split("\n").includes(pattern)) {
        content += `${pattern}
`;
        changed = true;
        log("Bridge exclude: added " + pattern);
      }
    }
    if (changed) {
      fs4.writeFileSync(excludeFile, content);
    }
  } catch {
    log("Bridge exclude: unable to locate .git dir, skipping");
  }
}

// src/lib/bridge/request.ts
import fs7 from "node:fs";

// src/lib/compile/applescript.ts
import { execSync as execSync3 } from "node:child_process";
function findUnityPid(projectPath) {
  try {
    const output = execSync3(
      `ps aux | grep '[U]nity' | grep "${projectPath}" | grep -v batchMode | awk '{print $2}' | head -1`,
      { encoding: "utf-8", timeout: 5e3 }
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}
function unityIsRunning(projectPath) {
  return findUnityPid(projectPath) !== null;
}
function triggerRefreshAppleScript(projectPath) {
  const pid = findUnityPid(projectPath);
  if (!pid) {
    log("AppleScript: Could not find Unity process");
    return null;
  }
  try {
    const result = execSync3(
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
      { encoding: "utf-8", timeout: 1e4 }
    ).trim();
    log("Triggered editor refresh via AppleScript");
    return result || null;
  } catch (err) {
    log(`AppleScript trigger failed: ${err}`);
    return null;
  }
}
function switchBackToApp(appName) {
  try {
    execSync3(`osascript -e 'tell application "${appName}" to activate'`, {
      timeout: 5e3
    });
  } catch {
  }
}
function triggerEditorRefreshOnly(projectPath) {
  const previousApp = triggerRefreshAppleScript(projectPath);
  if (previousApp) {
    switchBackToApp(previousApp);
  }
  log("Triggered editor refresh (trigger-only path)");
  return true;
}

// src/lib/bridge/launch.ts
import fs5 from "node:fs";
import path6 from "node:path";
import { spawn } from "node:child_process";
var UNITY_HUB_EDITOR_DIR = "/Applications/Unity/Hub/Editor";
function readUnityVersion(projectPath) {
  const versionFile = path6.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
  try {
    const content = fs5.readFileSync(versionFile, "utf-8");
    const match = content.match(/m_EditorVersion:\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
function resolveUnityBinary(version) {
  const binaryPath = path6.join(
    UNITY_HUB_EDITOR_DIR,
    version,
    "Unity.app",
    "Contents/MacOS/Unity"
  );
  if (!fs5.existsSync(binaryPath)) {
    throw new Error(
      `unity_not_found: Unity ${version} not found at ${binaryPath}. Ensure it is installed via Unity Hub.`
    );
  }
  return binaryPath;
}
async function ensureUnityRunning(projectPath, launchTimeoutMs = UNITY_LAUNCH_TIMEOUT_MS) {
  if (unityIsRunning(projectPath)) {
    return false;
  }
  const version = readUnityVersion(projectPath);
  if (!version) {
    throw new Error(
      `Could not detect Unity version from ProjectVersion.txt in ${projectPath}`
    );
  }
  const binaryPath = resolveUnityBinary(version);
  log(`Launching Unity ${version} for project: ${projectPath}`);
  process.stderr.write(
    `Unity not running. Launching Unity ${version} (this may take a moment)...
`
  );
  const child = spawn(binaryPath, ["-projectPath", projectPath], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    if (unityIsRunning(projectPath)) {
      log("Unity process detected after launch");
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `unity_launch_failed: Unity process did not appear within ${launchTimeoutMs / 1e3}s. Check Unity installation.`
  );
}

// src/lib/bridge/ipc.ts
import crypto2 from "node:crypto";
import fs6 from "node:fs";
function generateRequestId() {
  const secs = Math.floor(Date.now() / 1e3);
  const rnd = crypto2.randomBytes(4).toString("hex");
  return `${secs}-${process.pid}-${rnd}`;
}
function writeBridgeRequest(requestFilePath, request) {
  const tmpPath = requestFilePath + ".tmp";
  const wire = { ...request };
  if (request.payload && typeof request.payload === "object") {
    wire.payload = JSON.stringify(request.payload);
  }
  fs6.writeFileSync(tmpPath, JSON.stringify(wire));
  fs6.renameSync(tmpPath, requestFilePath);
  const now = /* @__PURE__ */ new Date();
  fs6.utimesSync(requestFilePath, now, now);
  log(`Wrote bridge request: action=${request.action} requestId=${request.requestId}`);
}
function readBridgeStatus(statusPath) {
  try {
    if (!fs6.existsSync(statusPath)) return null;
    const content = fs6.readFileSync(statusPath, "utf-8");
    const raw = JSON.parse(content);
    if (typeof raw.testResults === "string" && raw.testResults) {
      try {
        const parsed = JSON.parse(raw.testResults);
        if (raw.state === "list_tests_finished") {
          raw.testList = parsed;
          delete raw.testResults;
        } else {
          raw.testResults = parsed;
        }
      } catch {
      }
    }
    if (typeof raw.searchResults === "string" && raw.searchResults) {
      try {
        raw.searchResults = JSON.parse(raw.searchResults);
      } catch {
      }
    }
    return raw;
  } catch {
    return null;
  }
}
function readBridgeReady(readyPath) {
  try {
    if (!fs6.existsSync(readyPath)) return null;
    return JSON.parse(fs6.readFileSync(readyPath, "utf-8"));
  } catch {
    return null;
  }
}
function bridgeReadyMatchesProject(readyPath, projectPath) {
  const ready = readBridgeReady(readyPath);
  if (!ready) return false;
  return ready.projectPath === projectPath && ready.bridgeVersion === BRIDGE_VERSION && ready.protocolVersion === BRIDGE_PROTOCOL_VERSION;
}
function parseBridgeStatusToResult(status) {
  if (status.bridgeVersion !== BRIDGE_VERSION || status.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return {
      success: false,
      didCompile: false,
      errors: [
        `Bridge status version mismatch (got version=${status.bridgeVersion} protocol=${status.protocolVersion})`
      ]
    };
  }
  if (status.state === "bridge_error" || status.state === "timeout") {
    return {
      success: false,
      didCompile: false,
      errors: [status.summary || "Bridge error"]
    };
  }
  if (status.isSuccess) {
    return { success: true, didCompile: status.didCompile, errors: [] };
  }
  const errors = (status.errors || []).map((e) => {
    if (e.message?.startsWith(`${e.file}(`)) return e.message;
    if (e.file) return `${e.file}(${e.line},${e.column}): ${e.message}`;
    return e.message;
  });
  if (errors.length === 0)
    errors.push(status.summary || "Unity compilation failed");
  return { success: false, didCompile: status.didCompile, errors };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var TERMINAL_STATES = /* @__PURE__ */ new Set([
  "completed",
  "failed",
  "bridge_error",
  "timeout",
  "tests_finished",
  "list_tests_finished"
]);
async function waitForBridgeReady(readyPath, projectPath, timeoutMs) {
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
async function waitForBridgeStatus(statusPath, requestId, timeoutMs) {
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readBridgeStatus(statusPath);
    if (status && status.requestId === requestId) {
      if (status.bridgeVersion !== BRIDGE_VERSION || status.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (TERMINAL_STATES.has(status.state)) {
        log(
          `Bridge status final: requestId=${requestId} state=${status.state}`
        );
        return status;
      }
      deadline = Date.now() + timeoutMs;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log(`Timed out waiting for bridge status: requestId=${requestId}`);
  return null;
}

// src/lib/bridge/request.ts
function defaultTimeout(action) {
  if (action === "run_tests" || action === "list_tests") return TEST_STATUS_TIMEOUT_MS;
  return BRIDGE_STATUS_TIMEOUT_MS;
}
function reasonForAction(action) {
  if (action === "bootstrap_handshake") return "bridge bootstrap handshake";
  if (action === "search_assets") return "unity_search_assets MCP resource";
  return `unity_${action} MCP tool`;
}
async function sendBridgeRequest(projectPath, action, opts) {
  const freshlyLaunched = await ensureUnityRunning(projectPath);
  const paths = bridgePaths(projectPath);
  ensureBridgeInstalled(projectPath);
  ensureGitExclude(projectPath);
  fs7.mkdirSync(paths.ipcDir, { recursive: true });
  if (!bridgeReadyMatchesProject(paths.readyFile, projectPath)) {
    log("Bridge not ready, starting bootstrap flow");
    triggerEditorRefreshOnly(projectPath);
    const bootstrapTimeout = freshlyLaunched ? BRIDGE_READY_LAUNCH_TIMEOUT_MS : BRIDGE_READY_TIMEOUT_MS;
    const ready = await waitForBridgeReady(paths.readyFile, projectPath, bootstrapTimeout);
    if (!ready) {
      return { ok: false, error: "bridge_bootstrap_failed", message: "Bridge did not become ready after bootstrap refresh." };
    }
    const handshakeResult = await sendRawRequest(projectPath, paths, "bootstrap_handshake");
    if (!handshakeResult.ok) return handshakeResult;
    log("Bridge bootstrap handshake succeeded");
  }
  return sendRawRequest(projectPath, paths, action, opts);
}
async function sendRawRequest(projectPath, paths, action, opts) {
  const timeoutMs = opts?.timeoutMs ?? defaultTimeout(action);
  const requestId = generateRequestId();
  const statusPath = paths.statusFile(requestId);
  const requestPath = paths.requestFile(requestId);
  const request = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId,
    requestedAtUnixMs: Date.now(),
    projectPath,
    action,
    reason: reasonForAction(action),
    source: "unity-mcp",
    payload: opts?.payload
  };
  writeBridgeRequest(requestPath, request);
  const status = await waitForBridgeStatus(statusPath, requestId, timeoutMs);
  try {
    fs7.unlinkSync(statusPath);
  } catch (err) {
    const e = err;
    if (e.code !== "ENOENT") log(`Warning: failed to clean status file: ${e.message}`);
  }
  if (!status) {
    return { ok: false, error: "request_timeout", message: `Timed out waiting for bridge response (${action}).` };
  }
  if (status.bridgeVersion !== BRIDGE_VERSION || status.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: "version_mismatch",
      message: `Bridge version mismatch (got version=${status.bridgeVersion} protocol=${status.protocolVersion}).`
    };
  }
  if (status.state === "bridge_error") {
    return { ok: false, error: "bridge_error", message: status.summary || "Bridge error." };
  }
  return { ok: true, status };
}

// src/core/recompile.ts
var noopLogger = { log() {
}, error() {
} };
function parseErrorStrings(errorStrings) {
  return errorStrings.map((errStr) => {
    const match = errStr.match(/^(.+)\((\d+),(\d+)\):\s*(.+)$/);
    if (match) {
      return {
        assembly: "",
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: errStr,
        type: "error"
      };
    }
    return { assembly: "", file: "", line: 0, column: 0, message: errStr, type: "error" };
  });
}
async function recompile(projectPath, logger2 = noopLogger) {
  fs8.mkdirSync(MARKER_DIR, { recursive: true });
  const markerPath = getMarkerPath(projectPath, "recompile");
  ensureMarker(markerPath);
  const { changed: bridgeChangedThisRun } = ensureBridgeInstalled(projectPath);
  ensureGitExclude(projectPath);
  const csChanged = hasChangedCsFiles(projectPath, markerPath);
  if (!csChanged && !bridgeChangedThisRun) {
    logger2.log("No .cs files changed since last check \u2014 checking for existing errors");
    const checkResult = await sendBridgeRequest(projectPath, "recompile");
    if (checkResult.ok) {
      const parsed2 = parseBridgeStatusToResult(checkResult.status);
      if (!parsed2.success && parsed2.errors.length > 0) {
        logger2.log("Project still has compilation errors");
        return { success: false, skipped: false, errors: parseErrorStrings(parsed2.errors) };
      }
    }
    return { success: true, skipped: true, errors: [] };
  }
  logger2.log(bridgeChangedThisRun ? "Bridge updated, triggering recompilation" : "C# files changed, triggering recompilation");
  const result = await sendBridgeRequest(projectPath, "recompile");
  if (!result.ok) {
    return {
      success: false,
      skipped: false,
      errors: [{ assembly: "", file: "", line: 0, column: 0, message: result.message, type: "error" }]
    };
  }
  const parsed = parseBridgeStatusToResult(result.status);
  const success = parsed.success;
  const didCompile = parsed.didCompile;
  if (success || didCompile) {
    touchMarker(markerPath);
    logger2.log("Marker file updated");
  }
  return { success, skipped: false, errors: parseErrorStrings(parsed.errors) };
}

// node_modules/diff/libesm/diff/base.js
var Diff = class {
  diff(oldStr, newStr, options = {}) {
    let callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if ("callback" in options) {
      callback = options.callback;
    }
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);
    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));
    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }
  diffWithOptionsObj(oldTokens, newTokens, options, callback) {
    var _a;
    const done = (value) => {
      value = this.postProcess(value, options);
      if (callback) {
        setTimeout(function() {
          callback(value);
        }, 0);
        return void 0;
      } else {
        return value;
      }
    };
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if (options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;
    const bestPath = [{ oldPos: -1, lastComponent: void 0 }];
    let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
    }
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    const execEditLength = () => {
      for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        let basePath;
        const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = void 0;
        }
        let canAdd = false;
        if (addPath) {
          const addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = void 0;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }
        newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    };
    if (callback) {
      (function exec2() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback(void 0);
          }
          if (!execEditLength()) {
            exec2();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  }
  addToPath(path8, added, removed, oldPosInc, options) {
    const last = path8.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path8.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path8.oldPos + oldPosInc,
        lastComponent: { count: 1, added, removed, previousComponent: last }
      };
    }
  }
  extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
    }
    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
    }
    basePath.oldPos = oldPos;
    return newPos;
  }
  equals(left, right, options) {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  }
  removeEmpty(array) {
    const ret = [];
    for (let i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  castInput(value, options) {
    return value;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(value, options) {
    return Array.from(value);
  }
  join(chars) {
    return chars.join("");
  }
  postProcess(changeObjects, options) {
    return changeObjects;
  }
  get useLongestToken() {
    return false;
  }
  buildValues(lastComponent, newTokens, oldTokens) {
    const components = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();
    const componentLen = components.length;
    let componentPos = 0, newPos = 0, oldPos = 0;
    for (; componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value2, i) {
            const oldValue = oldTokens[oldPos + i];
            return oldValue.length > value2.length ? oldValue : value2;
          });
          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }
    return components;
  }
};

// node_modules/diff/libesm/diff/line.js
var LineDiff = class extends Diff {
  constructor() {
    super(...arguments);
    this.tokenize = tokenize;
  }
  equals(left, right, options) {
    if (options.ignoreWhitespace) {
      if (!options.newlineIsToken || !left.includes("\n")) {
        left = left.trim();
      }
      if (!options.newlineIsToken || !right.includes("\n")) {
        right = right.trim();
      }
    } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
      if (left.endsWith("\n")) {
        left = left.slice(0, -1);
      }
      if (right.endsWith("\n")) {
        right = right.slice(0, -1);
      }
    }
    return super.equals(left, right, options);
  }
};
var lineDiff = new LineDiff();
function diffLines(oldStr, newStr, options) {
  return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
  if (options.stripTrailingCr) {
    value = value.replace(/\r\n/g, "\n");
  }
  const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }
  return retLines;
}

// node_modules/diff/libesm/patch/create.js
function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  let optionsObj;
  if (!options) {
    optionsObj = {};
  } else if (typeof options === "function") {
    optionsObj = { callback: options };
  } else {
    optionsObj = options;
  }
  if (typeof optionsObj.context === "undefined") {
    optionsObj.context = 4;
  }
  const context = optionsObj.context;
  if (optionsObj.newlineIsToken) {
    throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
  }
  if (!optionsObj.callback) {
    return diffLinesResultToPatch(diffLines(oldStr, newStr, optionsObj));
  } else {
    const { callback } = optionsObj;
    diffLines(oldStr, newStr, Object.assign(Object.assign({}, optionsObj), { callback: (diff) => {
      const patch = diffLinesResultToPatch(diff);
      callback(patch);
    } }));
  }
  function diffLinesResultToPatch(diff) {
    if (!diff) {
      return;
    }
    diff.push({ value: "", lines: [] });
    function contextLines(lines) {
      return lines.map(function(entry) {
        return " " + entry;
      });
    }
    const hunks = [];
    let oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
    for (let i = 0; i < diff.length; i++) {
      const current = diff[i], lines = current.lines || splitLines(current.value);
      current.lines = lines;
      if (current.added || current.removed) {
        if (!oldRangeStart) {
          const prev = diff[i - 1];
          oldRangeStart = oldLine;
          newRangeStart = newLine;
          if (prev) {
            curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
            oldRangeStart -= curRange.length;
            newRangeStart -= curRange.length;
          }
        }
        for (const line of lines) {
          curRange.push((current.added ? "+" : "-") + line);
        }
        if (current.added) {
          newLine += lines.length;
        } else {
          oldLine += lines.length;
        }
      } else {
        if (oldRangeStart) {
          if (lines.length <= context * 2 && i < diff.length - 2) {
            for (const line of contextLines(lines)) {
              curRange.push(line);
            }
          } else {
            const contextSize = Math.min(lines.length, context);
            for (const line of contextLines(lines.slice(0, contextSize))) {
              curRange.push(line);
            }
            const hunk = {
              oldStart: oldRangeStart,
              oldLines: oldLine - oldRangeStart + contextSize,
              newStart: newRangeStart,
              newLines: newLine - newRangeStart + contextSize,
              lines: curRange
            };
            hunks.push(hunk);
            oldRangeStart = 0;
            newRangeStart = 0;
            curRange = [];
          }
        }
        oldLine += lines.length;
        newLine += lines.length;
      }
    }
    for (const hunk of hunks) {
      for (let i = 0; i < hunk.lines.length; i++) {
        if (hunk.lines[i].endsWith("\n")) {
          hunk.lines[i] = hunk.lines[i].slice(0, -1);
        } else {
          hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
          i++;
        }
      }
    }
    return {
      oldFileName,
      newFileName,
      oldHeader,
      newHeader,
      hunks
    };
  }
}
function splitLines(text) {
  const hasTrailingNl = text.endsWith("\n");
  const result = text.split("\n").map((line) => line + "\n");
  if (hasTrailingNl) {
    result.pop();
  } else {
    result.push(result.pop().slice(0, -1));
  }
  return result;
}

// src/core/lint.ts
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import fs9 from "node:fs";
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var execFileAsync = promisify(execFile);
var execAsync = promisify(exec);
var __dirname2 = path7.dirname(fileURLToPath2(import.meta.url));
var PKG_ROOT = fs9.existsSync(path7.resolve(__dirname2, "..", "package.json")) ? path7.resolve(__dirname2, "..") : path7.resolve(__dirname2, "..", "..");
var SETTINGS_PATH = path7.resolve(PKG_ROOT, "hooks", "TripleDot.DotSettings");
var noopLogger2 = { log() {
}, error() {
} };
async function getEditedLineRanges(projectPath, filePath) {
  let stdout;
  try {
    const result = await execAsync(
      `git -C "${projectPath}" diff HEAD -- "${filePath}"`,
      { timeout: 1e4 }
    );
    stdout = result.stdout;
  } catch {
    return [];
  }
  if (!stdout) return [];
  const ranges = [];
  const lines = stdout.split("\n");
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  let newLineNum = 0;
  let runStart = null;
  let runEnd = null;
  const flushRun = () => {
    if (runStart !== null && runEnd !== null) {
      ranges.push([runStart, runEnd]);
      runStart = null;
      runEnd = null;
    }
  };
  for (const line of lines) {
    const hunkMatch = hunkHeaderRe.exec(line);
    if (hunkMatch) {
      flushRun();
      const count = hunkMatch[2] !== void 0 ? parseInt(hunkMatch[2], 10) : 1;
      if (count === 0) {
        newLineNum = -1;
      } else {
        newLineNum = parseInt(hunkMatch[1], 10);
      }
      continue;
    }
    if (newLineNum === -1) continue;
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    } else if (line.startsWith("+")) {
      if (runStart === null) {
        runStart = newLineNum;
      }
      runEnd = newLineNum;
      newLineNum++;
    } else if (line.startsWith("-")) {
      flushRun();
    } else if (line.startsWith(" ") || line.startsWith("\\")) {
      flushRun();
      if (line.startsWith(" ")) {
        newLineNum++;
      }
    }
  }
  flushRun();
  return ranges;
}
function expandAndMerge(ranges, buffer, lineCount) {
  if (ranges.length === 0) return [];
  const expanded = ranges.map(([s, e]) => [
    Math.max(1, s - buffer),
    Math.min(lineCount, e + buffer)
  ]);
  expanded.sort((a, b) => a[0] - b[0]);
  const merged = [expanded[0]];
  for (let i = 1; i < expanded.length; i++) {
    const last = merged[merged.length - 1];
    const curr = expanded[i];
    if (curr[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}
function filterHunks(original, linted, allowedRanges) {
  if (allowedRanges.length === 0) return original;
  if (original === linted) return original;
  const patch = structuredPatch("file", "file", original, linted, "", "", { context: 1 });
  const acceptedHunks = patch.hunks.filter((hunk) => {
    const hunkStart = hunk.oldStart;
    const hunkEnd = hunk.oldStart + Math.max(hunk.oldLines - 1, 0);
    return allowedRanges.some(
      ([rStart, rEnd]) => hunkStart <= rEnd && hunkEnd >= rStart
    );
  });
  if (acceptedHunks.length === 0) return original;
  const lines = original.split("\n");
  const sorted = [...acceptedHunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of sorted) {
    const removeStart = hunk.oldStart - 1;
    const removeCount = hunk.oldLines;
    const newLines = hunk.lines.filter((l) => l.startsWith("+") || l.startsWith(" ")).map((l) => l.slice(1));
    lines.splice(removeStart, removeCount, ...newLines);
  }
  return lines.join("\n");
}
async function lint(projectPath, options = {}) {
  const logger2 = options.logger ?? noopLogger2;
  const bufferLines = options.bufferLines ?? 3;
  const compileResult = await recompile(projectPath, logger2);
  if (!compileResult.success && !compileResult.skipped) {
    logger2.error("Recompilation failed before lint");
    return { filesLinted: 0, success: false };
  }
  try {
    await execAsync("which jb", { timeout: 5e3 });
  } catch {
    logger2.log("Lint: jb not found, skipping");
    return { filesLinted: 0, success: true };
  }
  let changedOutput;
  try {
    const { stdout } = await execAsync(
      `git -C "${projectPath}" diff HEAD --name-only -- '*.cs'`,
      { timeout: 1e4 }
    );
    changedOutput = stdout.trim();
  } catch {
    logger2.log("Lint: could not get changed files, skipping");
    return { filesLinted: 0, success: true };
  }
  if (!changedOutput) {
    logger2.log("Lint: no changed .cs files, skipping");
    return { filesLinted: 0, success: true };
  }
  const files = changedOutput.split("\n").filter(Boolean).map((f) => path7.join(projectPath, f)).filter((f) => fs9.existsSync(f));
  if (files.length === 0) {
    logger2.log("Lint: no changed .cs files exist on disk, skipping");
    return { filesLinted: 0, success: true };
  }
  const snapshots = /* @__PURE__ */ new Map();
  const rangesMap = /* @__PURE__ */ new Map();
  for (const filePath of files) {
    const content = fs9.readFileSync(filePath, "utf-8");
    snapshots.set(filePath, content);
    const ranges = await getEditedLineRanges(projectPath, filePath);
    if (ranges.length > 0) {
      const lineCount = content.split("\n").length;
      rangesMap.set(filePath, expandAndMerge(ranges, bufferLines, lineCount));
    }
  }
  const filesToLint = [];
  for (const f of files) {
    const ranges = rangesMap.get(f);
    if (ranges && ranges.length > 0) {
      filesToLint.push(f);
      continue;
    }
    try {
      await execAsync(
        `git -C "${projectPath}" cat-file -e HEAD:"${path7.relative(projectPath, f)}"`,
        { timeout: 5e3 }
      );
    } catch {
      filesToLint.push(f);
    }
  }
  if (filesToLint.length === 0) {
    logger2.log("Lint: no files need linting after range analysis, skipping");
    return { filesLinted: 0, success: true };
  }
  logger2.log(`Lint: formatting ${filesToLint.length} file(s) with jb cleanupcode`);
  const args = ["cleanupcode", ...filesToLint];
  if (fs9.existsSync(SETTINGS_PATH)) {
    args.push(`--settings=${SETTINGS_PATH}`);
  }
  args.push("--disable-settings-layers=SolutionShared;SolutionPersonal;ProjectShared;ProjectPersonal");
  args.push("--profile=Formatting and Braces");
  args.push("--verbosity=WARN");
  try {
    await execFileAsync("jb", args, { timeout: 12e4 });
  } catch {
    logger2.log("Lint: jb cleanupcode returned non-zero (warnings likely)");
  }
  for (const filePath of filesToLint) {
    const snapshot = snapshots.get(filePath);
    const ranges = rangesMap.get(filePath);
    if (snapshot === void 0) continue;
    if (!ranges) continue;
    const linted = fs9.readFileSync(filePath, "utf-8");
    const filtered = filterHunks(snapshot, linted, ranges);
    if (filtered !== linted) {
      fs9.writeFileSync(filePath, filtered);
    }
  }
  logger2.log("Lint: done");
  return { filesLinted: filesToLint.length, success: true };
}

// src/hook/index.ts
function parseCwdFromStdin() {
  try {
    const stdin = fs10.readFileSync(0, "utf-8");
    if (stdin) {
      const data = JSON.parse(stdin);
      if (data.cwd) return data.cwd;
    }
  } catch {
  }
  return process.cwd();
}
var logger = {
  log(msg) {
    log(msg);
  },
  error(msg) {
    log(`ERROR: ${msg}`);
  }
};
async function main() {
  logger.log("=== Hook started ===");
  const cwd = parseCwdFromStdin();
  logger.log(`cwd: ${cwd}`);
  const projectPath = detectProject(cwd);
  if (!projectPath) {
    logger.log(`Not a Unity project: ${cwd}`);
    process.exit(0);
  }
  logger.log(`Unity project: ${projectPath}`);
  const skipMarker = `${projectPath}/.claude/hooks-skip-recompile`;
  if (fs10.existsSync(skipMarker)) {
    logger.log("Skipping: project has .claude/hooks-skip-recompile marker");
    process.exit(0);
  }
  const result = await recompile(projectPath, logger);
  if (result.skipped) {
    logger.log("No changes detected, exiting");
    process.exit(0);
  }
  if (result.success) {
    logger.log("SUCCESS: Unity recompilation complete");
    process.stderr.write("Unity compiled successfully\n");
    await lint(projectPath, { logger });
    process.exit(0);
  }
  logger.log("FAILED: Unity compilation errors found");
  process.stderr.write("Unity compilation failed:\n\n");
  process.stderr.write(result.errors.map((e) => e.message).join("\n") + "\n\n");
  process.stderr.write("Fix these errors to continue.\n");
  process.exit(2);
}
main().catch((err) => {
  logger.error(`Unhandled error: ${err}`);
  process.stderr.write(`Unity recompile hook error: ${err}
`);
  process.exit(1);
});
