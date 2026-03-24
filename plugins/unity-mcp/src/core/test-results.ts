import { loadTestRun, loadLatestTestRun } from "../lib/test-store.js";
import { getMarkerPath, hasChangedCsFiles } from "../lib/project/changes.js";
import type { TestResultsViewResult } from "./types.js";

export interface GetTestResultsOptions {
  projectPath: string;
  runId?: string;
  verbose?: boolean;
  statusFilter?: "passed" | "failed" | "skipped";
  nameFilter?: string;
  storeDir?: string;
  markerDir?: string;
}

export function getTestResults(opts: GetTestResultsOptions): TestResultsViewResult {
  const run = opts.runId
    ? loadTestRun(opts.runId, opts.storeDir)
    : loadLatestTestRun(opts.storeDir);

  if (!run) {
    return { formatted: "No test run found" + (opts.runId ? ` with ID ${opts.runId}` : "") + ".", stale: false };
  }

  // Check staleness
  const markerPath = getMarkerPath(opts.projectPath, "test-run", opts.markerDir);
  const stale = hasChangedCsFiles(opts.projectPath, markerPath);

  // Filter tests
  let tests = run.results.tests;
  if (opts.statusFilter) {
    const statusMap: Record<string, string> = { passed: "Passed", failed: "Failed", skipped: "Skipped" };
    const target = statusMap[opts.statusFilter];
    tests = tests.filter((t) => t.status === target);
  }
  if (opts.nameFilter) {
    const re = new RegExp(opts.nameFilter);
    tests = tests.filter((t) => re.test(t.fullName));
  }

  // Format output
  const lines: string[] = [];

  if (stale) {
    lines.push("WARNING: Results may be stale -- code has changed since this run.\n");
  }

  const ts = run.timestamp.replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
  lines.push(`Run ${run.runId} (${ts})`);
  lines.push(
    `Pass: ${run.results.passCount}  Fail: ${run.results.failCount}  Skip: ${run.results.skipCount}  (${run.results.duration.toFixed(1)}s)`,
  );

  if (opts.verbose) {
    lines.push("");
    for (const t of tests) {
      const icon = t.status === "Passed" ? "PASS" : t.status === "Failed" ? "FAIL" : "SKIP";
      lines.push(`  [${icon}] ${t.fullName} (${t.duration.toFixed(2)}s)`);
      if (t.message) lines.push(`    ${t.message}`);
      if (t.stackTrace) lines.push(`    ${t.stackTrace}`);
    }
  } else {
    // Summary: show failures
    const failures = tests.filter((t) => t.status === "Failed");
    if (failures.length > 0) {
      lines.push("");
      lines.push("Failures:");
      for (const t of failures) {
        lines.push(`  [FAIL] ${t.fullName} -- ${t.message || "no message"}`);
      }
    }
  }

  return { formatted: lines.join("\n"), stale };
}
