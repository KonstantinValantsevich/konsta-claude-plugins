import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  findLatestUnityVersion,
  unityBinaryPath,
  createUnityProject,
  isJbAvailable,
  closeUnityForProject,
} from "./helpers/unity.js";
import { writeState, readState, cleanupState } from "./helpers/state.js";

/** E2E project lives in the plugin root. */
const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROJECT_DIR = path.join(PLUGIN_ROOT, "e2e-project");

/** Synchronous cleanup — safe to call from signal handlers and process.on('exit'). */
function emergencyCleanup(): void {
  try {
    const state = readState();
    if (state.projectPath) {
      closeUnityForProject(state.projectPath);
      fs.rmSync(state.projectPath, { recursive: true, force: true });
    }
    cleanupState();
  } catch {
    // No state file — nothing to clean
  }
}

// Ensure cleanup on crashes, Ctrl+C, and unhandled errors
process.on("exit", emergencyCleanup);
process.on("SIGINT", () => { emergencyCleanup(); process.exit(1); });
process.on("SIGTERM", () => { emergencyCleanup(); process.exit(1); });
process.on("uncaughtException", (err) => {
  console.error("[E2E] Uncaught exception, cleaning up...", err);
  emergencyCleanup();
  process.exit(1);
});

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

  // 5. Add test-framework package (required for TestRunner API in bridge)
  const manifestPath = path.join(PROJECT_DIR, "Packages", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  manifest.dependencies["com.unity.test-framework"] = "1.4.5";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("[E2E] Added com.unity.test-framework package");

  // 6. Add Unity .gitignore so Library/, Temp/, Logs/ are never tracked
  fs.writeFileSync(path.join(PROJECT_DIR, ".gitignore"), [
    "/[Ll]ibrary/",
    "/[Tt]emp/",
    "/[Oo]bj/",
    "/[Bb]uild/",
    "/[Bb]uilds/",
    "/[Ll]ogs/",
    "/[Mm]emoryCaptures/",
    "/[Uu]serSettings/",
  ].join("\n") + "\n");

  // 6. Init git + tag baseline
  execSync("git init", { cwd: PROJECT_DIR, stdio: "ignore" });
  execSync("git add -A", { cwd: PROJECT_DIR, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: PROJECT_DIR, stdio: "ignore" });
  execSync("git tag e2e-baseline", { cwd: PROJECT_DIR, stdio: "ignore" });
  console.log("[E2E] Git initialized with e2e-baseline tag");

  // 7. Write shared state
  writeState({
    projectPath: PROJECT_DIR,
    unityVersion: version,
    jbAvailable,
  });

  console.log("[E2E] Global setup complete");

  // Return teardown function
  return async () => {
    console.log("[E2E] Starting global teardown...");
    try {
      const state = readState();
      if (state.projectPath) {
        console.log("[E2E] Closing Unity if running...");
        closeUnityForProject(state.projectPath);
        console.log("[E2E] Unity closed");
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
