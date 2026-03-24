import fs from "node:fs";
import path from "node:path";
import { TEST_STORE_DIR } from "./config.js";
import type { StoredTestRun } from "../core/types.js";

export function saveTestRun(
  run: StoredTestRun,
  storeDir: string = TEST_STORE_DIR,
): void {
  fs.mkdirSync(storeDir, { recursive: true });
  const filePath = path.join(storeDir, `${run.runId}.json`);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(run, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function loadTestRun(
  runId: string,
  storeDir: string = TEST_STORE_DIR,
): StoredTestRun | null {
  const filePath = path.join(storeDir, `${runId}.json`);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as StoredTestRun;
  } catch {
    return null;
  }
}

export function loadLatestTestRun(
  storeDir: string = TEST_STORE_DIR,
): StoredTestRun | null {
  try {
    if (!fs.existsSync(storeDir)) return null;
    const files = fs.readdirSync(storeDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;

    let latest: StoredTestRun | null = null;
    for (const file of files) {
      const content = fs.readFileSync(path.join(storeDir, file), "utf-8");
      const run = JSON.parse(content) as StoredTestRun;
      if (!latest || run.timestamp > latest.timestamp) {
        latest = run;
      }
    }
    return latest;
  } catch {
    return null;
  }
}
