import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveTestRun, loadTestRun, loadLatestTestRun } from "../../src/lib/test-store.js";
import type { StoredTestRun } from "../../src/core/types.js";

function makeRun(runId: string, timestamp: string): StoredTestRun {
  return {
    runId,
    timestamp,
    projectPath: "/fake/project",
    filters: {},
    results: {
      totalCount: 2,
      passCount: 1,
      failCount: 1,
      skipCount: 0,
      inconclusiveCount: 0,
      duration: 1.5,
      tests: [
        { fullName: "NS.Test1", name: "Test1", status: "Passed", duration: 0.5, message: null, stackTrace: null, output: null },
        { fullName: "NS.Test2", name: "Test2", status: "Failed", duration: 1.0, message: "Expected true", stackTrace: "at Test2:10", output: null },
      ],
    },
  };
}

describe("test-store", () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-store-"));
  });

  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  describe("saveTestRun", () => {
    it("writes a JSON file named by runId", () => {
      const run = makeRun("test-100", "2026-03-24T10:00:00Z");
      saveTestRun(run, storeDir);
      expect(fs.existsSync(path.join(storeDir, "test-100.json"))).toBe(true);
    });
  });

  describe("loadTestRun", () => {
    it("loads a previously saved run by ID", () => {
      const run = makeRun("test-200", "2026-03-24T11:00:00Z");
      saveTestRun(run, storeDir);
      const loaded = loadTestRun("test-200", storeDir);
      expect(loaded).toEqual(run);
    });

    it("returns null for non-existent run", () => {
      expect(loadTestRun("test-999", storeDir)).toBeNull();
    });
  });

  describe("loadLatestTestRun", () => {
    it("returns the run with the latest timestamp", () => {
      saveTestRun(makeRun("test-100", "2026-03-24T10:00:00Z"), storeDir);
      saveTestRun(makeRun("test-300", "2026-03-24T12:00:00Z"), storeDir);
      saveTestRun(makeRun("test-200", "2026-03-24T11:00:00Z"), storeDir);
      const latest = loadLatestTestRun(storeDir);
      expect(latest?.runId).toBe("test-300");
    });

    it("returns null when store is empty", () => {
      expect(loadLatestTestRun(storeDir)).toBeNull();
    });
  });
});
