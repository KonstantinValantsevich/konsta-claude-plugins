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

  const csprojs = fs
    .readdirSync(projectPath)
    .filter((f) => f.endsWith(".csproj"));
  if (csprojs.length === 0) {
    log("Lint: no .csproj files found, skipping");
    return;
  }

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
