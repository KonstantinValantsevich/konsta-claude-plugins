# Worktree-Aware Hook Design

## Problem

The unity-recompile hook fires on `Stop` and `SubagentStop` events. It reads `cwd` from stdin to determine the Unity project to recompile. When Claude Code sessions use git worktrees (via `Agent` with `isolation: "worktree"`), the `cwd` still points to the main project directory, not the worktree where changes were actually made. This causes the hook to recompile the wrong project.

## Solution

Use Claude Code's `WorktreeCreate` and `WorktreeRemove` hook events to track active worktrees in a shared state file. The hook entry point checks this state file on every invocation to determine the correct target directory.

## Architecture

### State File

- **Location:** `/tmp/unity-mcp-worktrees.json`
- **Format:** `{ [session_id: string]: string }` mapping session IDs to worktree paths
- **Concurrency:** Each session writes its own key. Atomic writes (write to temp file, rename) prevent corruption from concurrent sessions.
- **Cleanup:** Entries are removed by `WorktreeRemove`. As a safety net, entries older than 24 hours are pruned on read.

Example:
```json
{
  "sess-abc123": { "path": "/Users/konsta/projects/.worktrees/feature-x", "createdAt": 1711540800000 },
  "sess-def456": { "path": "/tmp/worktree-experiment", "createdAt": 1711540900000 }
}
```

### Hook Events

Register four events in `hooks.json`, all pointing to the same entry point (`unity-recompile.sh`):

| Event | Purpose |
|-------|---------|
| `Stop` | Recompile after main session or agent turn |
| `SubagentStop` | Recompile after subagent completes |
| `WorktreeCreate` | Record worktree path in state file |
| `WorktreeRemove` | Remove worktree path from state file |

### Hook Entry Point Logic

The hook reads `hook_event_name` from stdin to decide behavior:

```
read stdin → parse { session_id, cwd, hook_event_name, worktree_path? }

if hook_event_name == "WorktreeCreate":
    state[session_id] = worktree_path
    write state file
    exit 0

if hook_event_name == "WorktreeRemove":
    delete state[session_id]
    write state file
    exit 0

# Stop / SubagentStop / any other event:
target = state[session_id].path ?? cwd
detectProject(target) → recompile → lint
```

### Session ID Consistency

All events within a Claude Code session share the same `session_id`:
- `WorktreeCreate` (fires in main session) → `session_id`
- `Stop` (fires inside worktree agent) → same `session_id`
- `SubagentStop` (fires in main session after agent completes) → same `session_id`
- `WorktreeRemove` (fires in main session) → same `session_id`

This guarantees reliable mapping between worktree creation and subsequent recompile triggers.

### One Worktree Per Session

A session creates at most one worktree at a time (worktree agents cannot create nested worktrees). This makes the mapping a simple 1:1 `session_id → worktree_path`.

## Implementation Changes

### `hooks/hooks.json`

Add `WorktreeCreate` and `WorktreeRemove` entries alongside existing `Stop` and `SubagentStop`, all using the same command.

### `src/hook/index.ts`

1. **Parse additional stdin fields:** Extract `session_id`, `hook_event_name`, and `worktree_path` (present on `WorktreeCreate`/`WorktreeRemove`).
2. **New module `src/hook/worktree-state.ts`:**
   - `readState(): Record<string, string>` — read + prune stale entries (>24h)
   - `writeState(state: Record<string, string>): void` — atomic write (temp file + rename)
   - `registerWorktree(sessionId: string, worktreePath: string): void`
   - `unregisterWorktree(sessionId: string): void`
   - `resolveTarget(sessionId: string, fallbackCwd: string): string`
3. **Route by event name:** `WorktreeCreate`/`WorktreeRemove` → state management only. All other events → existing recompile flow with `resolveTarget()` providing the directory.

### No Changes Needed

- `detectUnityProject()` — works as-is, receives correct starting path
- `recompile()` / `lint()` — work as-is
- `unity-recompile.sh` — unchanged

## State File Details

### Atomic Writes

```typescript
// Write to temp file in same directory, then rename
const tmp = stateFilePath + `.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
fs.renameSync(tmp, stateFilePath);
```

### Stale Entry Pruning

Each entry includes a timestamp. On read, entries older than 24 hours are removed. This handles edge cases where `WorktreeRemove` never fires (e.g., session crash).

Updated format:
```json
{
  "sess-abc123": { "path": "/path/to/worktree", "createdAt": 1711540800000 }
}
```

### Missing State File

If the state file doesn't exist or can't be read, `resolveTarget` falls back to `cwd`. This preserves backward compatibility — the hook works exactly as before for non-worktree sessions.

## Testing

- Unit tests for `worktree-state.ts`: read/write/prune/resolve
- Unit test for hook routing by `hook_event_name`
- Integration test: simulate WorktreeCreate → Stop → WorktreeRemove flow
