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

  // 3. Clean slate — remove previous project if it exists
  if (fs.existsSync(PROJECT_DIR)) {
    console.log("[E2E] Removing previous project...");
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  }

  // 4. Create fresh project
  console.log(`[E2E] Creating Unity project at: ${PROJECT_DIR}`);
  createUnityProject(unityBinaryPath(version), PROJECT_DIR);
  console.log("[E2E] Unity project created");

  // 5. Init git + tag baseline
  execSync("git init", { cwd: PROJECT_DIR, stdio: "ignore" });
  execSync("git add -A", { cwd: PROJECT_DIR, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: PROJECT_DIR, stdio: "ignore" });
  execSync("git tag e2e-baseline", { cwd: PROJECT_DIR, stdio: "ignore" });
  console.log("[E2E] Git initialized with e2e-baseline tag");

  // 6. Open editor (non-batch)
  console.log("[E2E] Opening Unity Editor...");
  openUnityEditor(unityBinaryPath(version), PROJECT_DIR);

  // 7. Wait for Unity process to appear
  const pid = await waitForUnityProcess(PROJECT_DIR);
  console.log(`[E2E] Unity process detected: PID ${pid}`);

  // 8. Write shared state
  writeState({
    projectPath: PROJECT_DIR,
    unityVersion: version,
    unityPid: pid,
    jbAvailable,
  });

  console.log("[E2E] Global setup complete");

  // Return teardown function
  return async () => {
    console.log("[E2E] Starting global teardown...");
    try {
      const state = readState();
      if (state.unityPid) {
        console.log(`[E2E] Closing Unity (PID ${state.unityPid})...`);
        closeUnity(state.unityPid);
        console.log("[E2E] Unity closed");
      }
      if (state.projectPath) {
        console.log(`[E2E] Deleting project: ${state.projectPath}`);
        fs.rmSync(state.projectPath, { recursive: true, force: true });
        console.log("[E2E] Project deleted");
      }
      cleanupState();
    } catch {
      console.log("[E2E] No state file found, nothing to tear down");
    }
    console.log("[E2E] Global teardown complete");
  };
}
