import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "./config.js";

const LOG_FILE = path.join(CACHE_DIR, "unity-recompile.log");

export function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Logging failures are non-fatal
  }
}
