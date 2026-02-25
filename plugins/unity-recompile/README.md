# unity-recompile

Automatic Unity recompilation hook for Claude Code. When Claude finishes a turn that modified C# files in a Unity project, this plugin triggers Unity to recompile and reports any compilation errors back to Claude.

## Platform

macOS only. Uses AppleScript for Unity Editor integration and macOS-specific commands (`stat -f`, `md5 -q`).

## How It Works

1. **Stop hook** fires after each Claude turn
2. Detects if the current directory is inside a Unity project
3. Checks if any `.cs` files changed since last recompile (using file timestamp markers)
4. If changes detected:
   - Sends a recompile request to the Unity Editor via an IPC bridge (`ClaudeRecompileBridge.cs`)
   - Falls back to CLI batch mode if the Editor isn't running
   - Reports compilation success or errors back to Claude
5. On success, runs `dotnet format` lint in the background

## IPC Bridge

The plugin auto-installs a small C# editor script (`Assets/Recompile Hook/Editor/ClaudeRecompileBridge.cs`) into Unity projects. This script:
- Watches for recompile requests via filesystem IPC
- Triggers `AssetDatabase.Refresh()`
- Monitors compilation events and reports results
- Is automatically added to `.git/info/exclude` (not tracked by git)

## Commands

- `/unity-recompile` — Force recompilation regardless of detected changes
- `/unity-status` — Show project, editor, and bridge diagnostic information

## Runtime Data

Logs and markers are stored in `~/.claude/cache/unity-recompile/`:
- `unity-recompile.log` — Debug log
- `markers/recompile-<hash>` — Per-project timestamp markers

## Installation

```
/plugin marketplace add KonstantinValantsevich/konsta-claude-plugins
/plugin install unity-recompile@konsta-claude-plugins
```

## Migration from Manual Hook

If you previously had `unity-recompile.sh` configured directly in `~/.claude/settings.json`:

1. Remove the old Stop hook entry from `~/.claude/settings.json`
2. The old marker files in `~/.claude/hooks/markers/` can be deleted
3. Bridge files already in Unity projects continue to work
