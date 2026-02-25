---
description: Force Unity recompilation regardless of detected changes
allowed-tools: [Bash, Read, Glob]
---

# Unity Recompile

Force a Unity recompilation for the current project.

## Instructions

1. Determine the Unity project root by walking up from the current working directory, looking for a directory containing both `Assets/` and `ProjectSettings/ProjectVersion.txt`.

2. If no Unity project is found, tell the user: "Not inside a Unity project directory."

3. Clear the recompile marker to force change detection:
   ```bash
   PROJECT_HASH=$(echo -n "<project_path>" | md5 -q)
   rm -f ~/.claude/cache/unity-recompile/markers/recompile-$PROJECT_HASH
   ```

4. Run the recompile hook script directly:
   ```bash
   echo '{"cwd":"<current_working_directory>"}' | bash "${CLAUDE_PLUGIN_ROOT}/hooks/unity-recompile.sh"
   ```

5. Report the result to the user:
   - If exit code 0: "Unity compiled successfully."
   - If exit code 2: Show the compilation errors from stderr.
   - If other error: Show the error message.
