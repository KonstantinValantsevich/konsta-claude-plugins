# Bridge Auto-Launch Unity

Replace the CLI batch-mode fallback with automatic Unity launch integrated into the bridge request flow. When no Unity instance is running, the bridge spawns Unity interactively and proceeds with normal IPC once it's ready.

## Motivation

Currently only `recompile` has a CLI fallback (`cli-fallback.ts`) that runs Unity in batch mode. Other tools (`run_tests`, `list_tests`, `search_assets`) fail with `"unity_not_running"`. This creates an inconsistent experience — some tools work without Unity, others don't.

By moving the "ensure Unity is running" logic into the bridge itself, all tools get automatic Unity launch for free. Unity stays open after the operation, which is acceptable and useful for subsequent calls.

## Architecture

### New Module: `src/lib/bridge/launch.ts`

Exports `ensureUnityRunning(projectPath: string): Promise<void>`

**Flow:**
1. Call `unityIsRunning(projectPath)` — if true, return immediately
2. Read Unity version from `ProjectSettings/ProjectVersion.txt` (reuse logic from current `cli-fallback.ts`)
3. Resolve executable: `/Applications/Unity/Hub/Editor/{version}/Unity.app/Contents/MacOS/Unity`
4. Validate executable exists — throw `"unity_not_found"` if missing
5. Spawn: `spawn(unityPath, ["-projectPath", projectPath], { detached: true, stdio: "ignore" })` then `child.unref()`
6. Poll `unityIsRunning(projectPath)` until the process appears (30s timeout) — throw `"unity_launch_failed"` on timeout
7. Return

The `readUnityVersion` utility moves from `cli-fallback.ts` to `launch.ts`.

### Modified: `src/lib/bridge/request.ts`

The current early-exit check:
```typescript
if (!unityIsRunning(projectPath)) {
  return { ok: false, error: "unity_not_running", message: "..." };
}
```

Becomes:
```typescript
await ensureUnityRunning(projectPath);
```

If `ensureUnityRunning` throws, the error propagates to the calling tool.

**Bootstrap timeout:** When Unity was just launched (wasn't already running), use 300s for the bootstrap handshake instead of the default 120s. Unity needs time to load the project, import assets, and compile scripts before the bridge becomes ready.

### Deleted: `src/lib/compile/cli-fallback.ts`

Entirely replaced by `launch.ts`. No more batch-mode execution.

### Modified: `src/core/recompile.ts`

Remove the branching logic:
```typescript
// BEFORE
if (unityIsRunning(projectPath)) {
  result = await sendBridgeRequest(projectPath, "recompile");
} else {
  result = await runCliFallback(projectPath);
}

// AFTER
result = await sendBridgeRequest(projectPath, "recompile");
```

No tool-level code needs to know whether Unity was already running.

## Error Handling

| Error | Cause | Message |
|-------|-------|---------|
| `unity_not_found` | Unity executable doesn't exist at expected Hub path | Includes version and expected path |
| `unity_launch_failed` | Unity process didn't appear within 30s of spawning | Suggests checking Unity installation |
| `bridge_bootstrap_failed` | Unity launched but bridge didn't become ready within 300s | Existing error, timeout increased for launch case |

## Timeouts

| Timeout | Value | Context |
|---------|-------|---------|
| Process appear after spawn | 30s | Unity binary should start quickly even if project load is slow |
| Bridge bootstrap (fresh launch) | 300s | Project import + script compilation on first open |
| Bridge bootstrap (already running) | 120s | Unchanged from current behavior |

## E2E Test Changes

### Global Setup (`global-setup.ts`)

**Remove:**
- `openUnityEditor()` call (step 6)
- `waitForUnityProcess()` call (step 7)
- `unityPid` from shared state

**Keep:**
- Find Unity version
- Check jb availability
- Clean previous project
- Create fresh Unity project (batch mode)
- Add test-framework package
- Git init + baseline tag

**State shape:** `{ projectPath, unityVersion, jbAvailable }` (no `unityPid`)

### Teardown

Replace PID-based cleanup with dynamic detection:
- Use `findUnityPid(projectPath)` to locate Unity if still running
- Kill if found, skip if not

Emergency cleanup follows the same pattern.

### Test Suite `01-bridge-lifecycle.test.ts`

- First tool call (`unity_recompile` in `beforeAll`) now implicitly launches Unity via the bridge
- This serves as the "auto-open" test — if Unity can't launch, `bail: 1` kills the entire e2e run
- Remove `unityPid` from state reads; use `findUnityPid(projectPath)` where PID is needed (e.g., test 3 osascript refresh)

### Other Test Suites

No changes needed — they all call tools through the bridge, which handles Unity lifecycle automatically.

## Unit Tests

### New: `launch.test.ts`
- Mock `child_process.spawn` — verify called with `{ detached: true, stdio: "ignore" }`
- Verify `.unref()` called on child process
- Verify function doesn't await/block on child process exit
- Test `readUnityVersion` parsing
- Test executable path validation (missing version file, missing binary)
- Test timeout when process doesn't appear

### Modified: bridge `request.test.ts`
- Replace `"unity_not_running"` test case with `ensureUnityRunning` integration
- Add case: Unity not running -> launched -> bootstrap succeeds
- Add case: Unity not running -> launch fails -> error propagated

### Deleted: `cli-fallback.test.ts`
- No longer needed

## Files Changed

| File | Action |
|------|--------|
| `src/lib/bridge/launch.ts` | **New** — `ensureUnityRunning()`, `readUnityVersion()` |
| `src/lib/bridge/request.ts` | **Modified** — call `ensureUnityRunning` instead of early return |
| `src/lib/compile/cli-fallback.ts` | **Deleted** |
| `src/core/recompile.ts` | **Modified** — remove fallback branch |
| `__tests__/e2e/global-setup.ts` | **Modified** — remove Unity launch |
| `__tests__/e2e/01-bridge-lifecycle.test.ts` | **Modified** — remove PID from state, use dynamic detection |
| `__tests__/e2e/helpers/unity.ts` | **Modified** — may remove `openUnityEditor` if unused |
| Unit tests for launch, request, cli-fallback | **New/Modified/Deleted** as described above |
