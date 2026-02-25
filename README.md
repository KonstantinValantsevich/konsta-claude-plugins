# Claude Unity Plugins

A marketplace of Claude Code plugins for Unity game development.

## Installation

Add this marketplace to Claude Code:

```
/plugin marketplace add KonstantinValantsevich/claude-unity-plugins
```

Then install individual plugins:

```
/plugin install unity-recompile@claude-unity-plugins
```

## Plugins

### unity-recompile

Automatic Unity recompilation hook for Claude Code. Detects C# file changes after each Claude turn and triggers Unity recompilation with structured error reporting via an IPC bridge.

**Features:**
- Automatic .cs change detection using file timestamps
- IPC bridge to Unity Editor for reliable recompilation status
- AppleScript fallback for triggering Unity refresh
- CLI batch mode fallback when Unity Editor isn't running
- `dotnet format` lint on successful compilation
- Slash commands: `/unity-recompile` (force), `/unity-status` (diagnostics)

**Platform:** macOS only

## License

MIT
