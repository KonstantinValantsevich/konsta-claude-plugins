import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { detectProject } from "../core/detect.js";
import { recompile } from "../core/recompile.js";
import { lint } from "../core/lint.js";
import { log } from "../lib/logger.js";
import { registerWorktree, unregisterWorktree, resolveTarget } from "./worktree-state.js";
import type { Logger } from "../core/types.js";

export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  worktree_path?: string;
}

function parseStdinInput(): HookInput {
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    if (stdin) {
      const data = JSON.parse(stdin);
      return {
        session_id: data.session_id ?? "",
        cwd: data.cwd ?? process.cwd(),
        hook_event_name: data.hook_event_name ?? "",
        worktree_path: data.worktree_path,
      };
    }
  } catch {
    // Ignore parse errors
  }
  return { session_id: "", cwd: process.cwd(), hook_event_name: "" };
}

const logger: Logger = {
  log(msg) { log(msg); },
  error(msg) { log(`ERROR: ${msg}`); },
};

export async function handleHook(input: HookInput): Promise<string> {
  logger.log(`=== Hook started (${input.hook_event_name}) ===`);

  // Worktree bookkeeping events
  if (input.hook_event_name === "WorktreeCreate") {
    if (input.worktree_path && input.session_id) {
      registerWorktree(input.session_id, input.worktree_path);
      logger.log(`Registered worktree: ${input.worktree_path} for session ${input.session_id}`);
    }
    return "registered";
  }

  if (input.hook_event_name === "WorktreeRemove") {
    if (input.session_id) {
      unregisterWorktree(input.session_id);
      logger.log(`Unregistered worktree for session ${input.session_id}`);
    }
    return "unregistered";
  }

  // Recompile events (Stop, SubagentStop, etc.)
  const target = resolveTarget(input.session_id, input.cwd);
  logger.log(`target: ${target} (cwd: ${input.cwd}, session: ${input.session_id})`);

  const projectPath = detectProject(target);
  if (!projectPath) {
    logger.log(`Not a Unity project: ${target}`);
    return "not-unity";
  }
  logger.log(`Unity project: ${projectPath}`);

  // Skip marker check (adapter-level policy)
  const skipMarker = `${projectPath}/.claude/hooks-skip-recompile`;
  if (fs.existsSync(skipMarker)) {
    logger.log("Skipping: project has .claude/hooks-skip-recompile marker");
    return "skipped-marker";
  }

  const result = await recompile(projectPath, logger);

  if (result.skipped) {
    logger.log("No changes detected, exiting");
    return "skipped";
  }

  if (result.success) {
    logger.log("SUCCESS: Unity recompilation complete");
    process.stderr.write("Unity compiled successfully\n");
    await lint(projectPath, { logger });
    return "success";
  }

  // Compilation errors
  logger.log("FAILED: Unity compilation errors found");
  process.stderr.write("Unity compilation failed:\n\n");
  process.stderr.write(result.errors.map((e) => e.message).join("\n") + "\n\n");
  process.stderr.write("Fix these errors to continue.\n");
  return "failed";
}

async function main(): Promise<void> {
  const input = parseStdinInput();
  const result = await handleHook(input);

  if (result === "failed") {
    process.exit(2);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    logger.error(`Unhandled error: ${err}`);
    process.stderr.write(`Unity recompile hook error: ${err}\n`);
    process.exit(1);
  });
}
