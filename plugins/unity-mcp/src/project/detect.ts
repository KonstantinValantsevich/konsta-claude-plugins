import fs from "node:fs";
import path from "node:path";

/**
 * Walk up from `cwd` to find the nearest Unity project root.
 * A Unity project has both `Assets/` and `ProjectSettings/ProjectVersion.txt`.
 * Returns the project root path, or null if not found.
 */
export function detectUnityProject(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    if (
      fs.existsSync(path.join(dir, "Assets")) &&
      fs.existsSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
