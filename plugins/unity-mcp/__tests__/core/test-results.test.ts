import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getTestResults } from "../../src/core/test-results.js";
import { saveTestRun } from "../../src/lib/test-store.js";
import { getMarkerPath } from "../../src/lib/project/changes.js";
import type { StoredTestRun } from "../../src/core/types.js";

function makeRun(): StoredTestRun {
  return {
    runId: "test-100",
    timestamp: "2026-03-24T10:00:00Z",
    projectPath: "/fake/project",
    filters: {},
    results: {
      totalCount: 4,
      passCount: 2,
      failCount: 1,
      skipCount: 1,
      inconclusiveCount: 0,
      duration: 3.5,
      tests: [
        { fullName: "NS.ClassA.Test1", name: "Test1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null },
        { fullName: "NS.ClassA.Test2", name: "Test2", status: "Passed", duration: 0.8, message: null, stackTrace: null, output: null },
        { fullName: "NS.ClassB.Test3", name: "Test3", status: "Failed", duration: 1.2, message: "Expected 5 got 4", stackTrace: "at Test3:42", output: null },
        { fullName: "NS.ClassB.Test4", name: "Test4", status: "Skipped", duration: 0.0, message: "Ignored", stackTrace: null, output: null },
      ],
    },
  };
}

describe("getTestResults", () => {
  let storeDir: string;
  let projectDir: string;
  let markerDir: string;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-results-store-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-results-proj-"));
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-results-markers-"));
    fs.mkdirSync(path.join(projectDir, "Assets"), { recursive: true });
    saveTestRun(makeRun(), storeDir);
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
  });

  it("returns formatted summary by default", () => {
    const result = getTestResults({ projectPath: projectDir, storeDir, markerDir });
    expect(result.formatted).toContain("2");
    expect(result.formatted).toContain("1");
  });

  it("returns verbose output when requested", () => {
    const result = getTestResults({ projectPath: projectDir, verbose: true, storeDir, markerDir });
    expect(result.formatted).toContain("NS.ClassA.Test1");
    expect(result.formatted).toContain("NS.ClassA.Test2");
    expect(result.formatted).toContain("NS.ClassB.Test3");
  });

  it("filters by status", () => {
    const result = getTestResults({ projectPath: projectDir, statusFilter: "failed", verbose: true, storeDir, markerDir });
    expect(result.formatted).toContain("NS.ClassB.Test3");
    expect(result.formatted).not.toContain("NS.ClassA.Test1");
  });

  it("filters by name pattern", () => {
    const result = getTestResults({ projectPath: projectDir, nameFilter: "ClassA", verbose: true, storeDir, markerDir });
    expect(result.formatted).toContain("NS.ClassA.Test1");
    expect(result.formatted).not.toContain("NS.ClassB.Test3");
  });

  it("loads specific run by ID", () => {
    const result = getTestResults({ projectPath: projectDir, runId: "test-100", storeDir, markerDir });
    expect(result.formatted).toContain("test-100");
  });

  it("returns error for non-existent run", () => {
    const result = getTestResults({ projectPath: projectDir, runId: "test-999", storeDir, markerDir });
    expect(result.formatted).toContain("No test run found");
  });

  it("detects staleness when code changed", async () => {
    const markerPath = getMarkerPath(projectDir, "test-run", markerDir);
    const past = new Date(Date.now() - 60_000);
    fs.writeFileSync(markerPath, "");
    fs.utimesSync(markerPath, past, past);
    fs.writeFileSync(path.join(projectDir, "Assets", "New.cs"), "class New {}");

    const result = getTestResults({ projectPath: projectDir, storeDir, markerDir });
    expect(result.stale).toBe(true);
    expect(result.formatted).toContain("stale");
  });
});
