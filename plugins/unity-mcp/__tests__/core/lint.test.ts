import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { lint } from "../../src/core/lint.js";

describe("lint", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity-core-lint-"));
    // Initialize a git repo so `git diff` works
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit --allow-empty -m 'init'", { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns filesLinted=0 when no changed .cs files", async () => {
    const result = await lint(tmpDir);
    expect(result.filesLinted).toBe(0);
    expect(result.success).toBe(true);
  });
});
