import fs from "node:fs";
import { detectProject } from "../core/detect.js";
import { recompile } from "../core/recompile.js";
import { lint } from "../core/lint.js";
import { log } from "../lib/logger.js";
import type { Logger } from "../core/types.js";

function parseCwdFromStdin(): string {
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    if (stdin) {
      const data = JSON.parse(stdin);
      if (data.cwd) return data.cwd;
    }
  } catch {
    // Ignore parse errors
  }
  return process.cwd();
}

const logger: Logger = {
  log(msg) { log(msg); },
  error(msg) { log(`ERROR: ${msg}`); },
};

async function main(): Promise<void> {
  logger.log("=== Hook started ===");

  const cwd = parseCwdFromStdin();
  logger.log(`cwd: ${cwd}`);

  const projectPath = detectProject(cwd);
  if (!projectPath) {
    logger.log(`Not a Unity project: ${cwd}`);
    process.exit(0);
  }
  logger.log(`Unity project: ${projectPath}`);

  // Skip marker check (adapter-level policy)
  const skipMarker = `${projectPath}/.claude/hooks-skip-recompile`;
  if (fs.existsSync(skipMarker)) {
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
    await lint(projectPath, logger);
    process.exit(0);
  }

  // Compilation errors
  logger.log("FAILED: Unity compilation errors found");
  process.stderr.write("Unity compilation failed:\n\n");
  process.stderr.write(result.errors.map((e) => e.message).join("\n") + "\n\n");
  process.stderr.write("Fix these errors to continue.\n");
  process.exit(2);
}

main().catch((err) => {
  logger.error(`Unhandled error: ${err}`);
  process.stderr.write(`Unity recompile hook error: ${err}\n`);
  process.exit(1);
});
