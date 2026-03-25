import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  findLatestUnityVersion,
  unityBinaryPath,
  createUnityProject,
  openUnityEditor,
  waitForUnityProcess,
  isJbAvailable,
  closeUnity,
} from "./helpers/unity.js";
import { writeState, readState, cleanupState } from "./helpers/state.js";

/** E2E project lives in the plugin root, persists across runs. */
const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROJECT_DIR = path.join(PLUGIN_ROOT, ".e2e-project");

export default async function globalSetup(): Promise<() => Promise<void>> {
  console.log("[E2E] Starting global setup...");

  // 1. Find Unity
  const version = findLatestUnityVersion();
  console.log(`[E2E] Found Unity version: ${version}`);

  // 2. Check jb
  const jbAvailable = isJbAvailable();
  console.log(`[E2E] jb CLI available: ${jbAvailable}`);

  // 3. Create project if it doesn't exist
  if (!fs.existsSync(path.join(PROJECT_DIR, "ProjectSettings"))) {
    console.log(`[E2E] Creating Unity project at: ${PROJECT_DIR}`);
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    createUnityProject(unityBinaryPath(version), PROJECT_DIR);
    console.log("[E2E] Unity project created");
  } else {
    console.log(`[E2E] Reusing existing project at: ${PROJECT_DIR}`);
  }

  // 4. Init git repo if needed
  if (!fs.existsSync(path.join(PROJECT_DIR, ".git"))) {
    execSync("git init", { cwd: PROJECT_DIR, stdio: "ignore" });
    execSync("git add -A", { cwd: PROJECT_DIR, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: PROJECT_DIR, stdio: "ignore" });
    execSync("git tag e2e-baseline", { cwd: PROJECT_DIR, stdio: "ignore" });
    console.log("[E2E] Git initialized with e2e-baseline tag");
  }

  // 5. Open editor (non-batch)
  console.log("[E2E] Opening Unity Editor...");
  openUnityEditor(unityBinaryPath(version), PROJECT_DIR);

  // 6. Wait for Unity process to appear
  const pid = await waitForUnityProcess(PROJECT_DIR);
  console.log(`[E2E] Unity process detected: PID ${pid}`);

  // 7. Re-tag baseline if tag is missing (project existed but git was re-initialized)
  try {
    execSync("git rev-parse e2e-baseline", { cwd: PROJECT_DIR, stdio: "ignore" });
  } catch {
    execSync("git add -A", { cwd: PROJECT_DIR, stdio: "ignore" });
    execSync('git commit --allow-empty -m "initial"', { cwd: PROJECT_DIR, stdio: "ignore" });
    execSync("git tag e2e-baseline", { cwd: PROJECT_DIR, stdio: "ignore" });
    console.log("[E2E] Re-created e2e-baseline tag");
  }

  // 8. Write shared state
  writeState({
    projectPath: PROJECT_DIR,
    unityVersion: version,
    unityPid: pid,
    jbAvailable,
  });

  console.log("[E2E] Global setup complete");

  // Return teardown function — close Unity but keep the project for reuse
  return async () => {
    console.log("[E2E] Starting global teardown...");
    try {
      const state = readState();
      if (state.unityPid) {
        console.log(`[E2E] Closing Unity (PID ${state.unityPid})...`);
        closeUnity(state.unityPid);
        console.log("[E2E] Unity closed");
      }
      cleanupState();
    } catch {
      console.log("[E2E] No state file found, nothing to tear down");
    }
    console.log("[E2E] Global teardown complete");
  };
}
