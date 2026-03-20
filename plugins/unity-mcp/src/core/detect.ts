import { detectUnityProject } from "../lib/project/detect.js";

/**
 * Detect if a directory is inside a Unity project.
 * Walks up the filesystem looking for Assets/ + ProjectSettings/ProjectVersion.txt.
 * Returns the project root path or null.
 */
export function detectProject(cwd: string): string | null {
  return detectUnityProject(cwd);
}
