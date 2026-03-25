import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  findLatestUnityVersion,
  unityBinaryPath,
  createUnityProject,
  openUnityEditor,
  waitForUnityProcess,
  isJbAvailable,
} from "./helpers/unity.js";
import { writeState, readState, cleanupState } from "./helpers/state.js";
import { closeUnity } from "./helpers/unity.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
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

  // 4. Init git repo (before editor, so .git exists)
  execSync("git init", { cwd: projectDir, stdio: "ignore" });

  // 5. Open editor (non-batch)
  console.log("[E2E] Opening Unity Editor...");
  openUnityEditor(unityBinaryPath(version), projectDir);

  // 6. Wait for Unity process to appear
  const pid = await waitForUnityProcess(projectDir);
  console.log(`[E2E] Unity process detected: PID ${pid}`);

  // 7. Let Unity settle (writes Library/, Logs/, etc.), then snapshot baseline
  console.log("[E2E] Waiting for Unity to settle...");
  await new Promise((r) => setTimeout(r, 15_000));
  execSync("git add -A", { cwd: projectDir, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: projectDir, stdio: "ignore" });
  execSync("git tag e2e-baseline", { cwd: projectDir, stdio: "ignore" });
  console.log("[E2E] Git initialized with e2e-baseline tag");

  // 8. Write shared state
  writeState({
    projectPath: projectDir,
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
