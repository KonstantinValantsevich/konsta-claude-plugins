---
description: Show Unity project and recompile bridge status
allowed-tools: [Bash, Read, Glob]
---

# Unity Status

Show diagnostic information about the Unity project and recompile bridge.

## Instructions

Gather and display the following information. Use Bash to run each check:

### 1. Unity Project Detection

Walk up from the current working directory looking for `Assets/` + `ProjectSettings/ProjectVersion.txt`. Report:
- Whether a Unity project was found
- The project path
- The Unity version from `ProjectSettings/ProjectVersion.txt` (the `m_EditorVersion:` line)

If no project found, report "Not inside a Unity project" and stop.

### 2. Unity Editor Status

```bash
ps aux | grep "[U]nity" | grep "<project_path>" | grep -v batchMode
```

Report whether Unity Editor is running for this project.

### 3. Bridge Status

Check `<project_path>/Library/ClaudeHookIPC/bridge-ready.json`:
- If it exists, read and report: `bridgeVersion`, `protocolVersion`, `readyAtUnixMs` (convert to human-readable time)
- If it doesn't exist, report "Bridge not ready (no bridge-ready.json)"

Check if bridge C# file is installed:
```bash
ls -la "<project_path>/Assets/Recompile Hook/Editor/ClaudeRecompileBridge.cs"
```

### 4. Last Recompile

```bash
PROJECT_HASH=$(echo -n "<project_path>" | md5 -q)
stat -f "%Sm" ~/.claude/cache/unity-recompile/markers/recompile-$PROJECT_HASH
```

Report the last recompile marker timestamp, or "Never run" if the marker doesn't exist.

### 5. Format as Summary

Present results in a clear format:

```
Unity Project: <path>
Unity Version: <version>
Editor Running: Yes/No
Bridge Installed: Yes/No
Bridge Ready: Yes/No (version X, protocol Y)
Last Recompile: <timestamp> or Never
```
