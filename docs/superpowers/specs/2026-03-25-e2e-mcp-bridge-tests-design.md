# E2E Tests for MCP Tools & Bridge

## Problem

The unity-mcp plugin has unit and integration tests that mock the Unity side, but no tests that exercise the full stack: MCP protocol → core functions → bridge IPC → real Unity Editor → C# handlers → responses. Critical workflows (bridge installation, version updates, recompilation, test running, linting) are only validated against mocks.

## Design

### Overview

End-to-end tests that create a real Unity project, open Unity Editor (non-batch mode), and call MCP tools through the full MCP protocol. Tests verify the complete chain from MCP tool invocation to Unity Editor response.

### Unity Lifecycle

Single Unity Editor instance for the entire E2E suite:

1. **Find Unity** — scan `/Applications/Unity/Hub/Editor/` for installed versions, pick latest (semver sort)
2. **Create project** — `/Applications/Unity/Hub/Editor/<VERSION>/Unity.app/Contents/MacOS/Unity -createProject <tmpDir> -quit -batchmode`
3. **Init git** — `git init && git add -A && git commit -m "initial"` (required for lint's `git diff HEAD` and change detection)
4. **Tag baseline** — `git tag e2e-baseline` (clean restore point for each phase)
5. **Open editor** — `open -a "...Unity.app" --args -projectPath <tmpDir>` (non-batch mode)
6. **Wait for ready** — poll `ps aux` until Unity process detected for project path

Teardown:
1. Close Unity (kill process)
2. Delete temp project directory

### MCP Tool Invocation

Tests call tools through the real MCP protocol:
- Spawn MCP server as child process (`node dist/server.mjs`)
- Connect via MCP SDK `Client` + `StdioClientTransport`
- Each test file creates its own client in `beforeAll`, closes in `afterAll`
- `callTool(name, args)` wrapper returns MCP tool result content

### Cross-Phase Isolation

Each test file's `beforeAll` resets to baseline:
```
git reset --hard e2e-baseline && git clean -fd
```

This makes phases fully independent — each starts from the clean Unity project state regardless of what previous phases did. Each phase writes its own C# files and recompiles as needed.

### Failure Strategy

- **Within a file**: sequential execution, bail on first failure — remaining tests in the phase are skipped
- **Cross-file**: independent due to git baseline reset — one phase failing doesn't cascade

### Test Phases

#### Phase 01 — Bridge Lifecycle (`01-bridge-lifecycle.test.ts`)

| # | Test | Verification |
|---|------|-------------|
| 1 | First tool call installs bridge | Call `unity_recompile` → bridge files appear in `Assets/Claude Bridge/Editor/`, recompile succeeds |
| 2 | Status shows bridge ready | `unity_status` → `editorRunning: true`, `bridgeReady: true`, correct `unityVersion` and `bridgeVersion` |
| 3 | Bridge version auto-update (no user file changes) | Overwrite bridge `.cs` files with lower version string → trigger `Cmd+R` via osascript so Unity recompiles stale bridge → wait for bridge-ready with stale version → call `unity_list_tests` (no C# user files changed, so no auto-recompile) → `sendBridgeRequest` detects version mismatch, reinstalls correct `.cs` files, osascript refresh, bridge becomes ready with correct version |

#### Phase 02 — Recompile (`02-recompile.test.ts`)

| # | Test | Verification |
|---|------|-------------|
| 4 | No changes → skip | `unity_recompile` with no new C# files → result indicates skipped |
| 5 | Valid C# file → success | Write `SimpleComponent.cs` (valid MonoBehaviour) to `Assets/` → `unity_recompile` → succeeds, no errors |
| 6 | Compile error → reports errors | Write `BrokenScript.cs` with syntax error → `unity_recompile` → returns compilation errors with file/line info |
| 7 | Fix error → success | Fix `BrokenScript.cs` → `unity_recompile` → succeeds |

#### Phase 03 — Tests (`03-tests.test.ts`)

| # | Test | Verification |
|---|------|-------------|
| 8 | List tests — empty | `unity_list_tests` → empty list (no test classes in clean project) |
| 9 | Add passing test → list finds it | Write EditMode test class with `[Test]` method → `unity_recompile` → `unity_list_tests` → test appears by name |
| 10 | Run tests → pass | `unity_run_tests` → passCount=1, failCount=0 |
| 11 | Add failing test → run → failure reported | Add test with `Assert.Fail()` → `unity_recompile` → `unity_run_tests` → failCount > 0, failure message present |
| 12 | Filter by category | Add `[Category("Slow")]` to a test → `unity_run_tests` with `categoryNames: ["Slow"]` → only that test runs |
| 13 | Retrieve previous results | `unity_test_results` → returns results from last run, matches run ID |
| 14 | Stale results detection | Write new C# file (change code) → `unity_test_results` → flags results as stale |

#### Phase 04 — Lint (`04-lint.test.ts`)

| # | Test | Verification |
|---|------|-------------|
| 15 | Lint formats changed file | Write a well-formatted `.cs` file → `git add && git commit` → overwrite with badly formatted version → `unity_lint` → file gets cleaned up, `filesLinted > 0`, verify specific fixes applied |

**Lint test fixture** — maximizes violations of active DotSettings WARNING rules:

```csharp
using System;
using System.Collections.Generic;
using UnityEngine;
namespace  BadFormatting{
public class LintTest:MonoBehaviour{
  [SerializeField]  private  static readonly int BadField=42;
  [SerializeField] int anotherField = 10;
    static public void  BadMethod( string arg1,int arg2 ){
    if(arg1 == null)
      Debug.Log("no braces");
    for(int i=0;i<arg2;i++)
      Debug.Log(i);
    foreach(var item in new List<int>{1,2,3})
      Debug.Log(item);
    while(arg2>0)
      arg2--;
    var x = new Dictionary<string,int>(){{"a",1},{"b",2}};
    Debug.Log( $"test" ); Debug.Log("same line");
    }


public void AnotherMethod(){} public void ThirdMethod(){}
}
}
```

**Violations covered:**
- `BadBracesSpaces` / `BadDeclarationBracesLineBreaks` — `{` on same line with no space
- `BadColonSpaces` — `:MonoBehaviour` no space
- `BadCommaSpaces` — `arg1,int` no space after comma
- `BadParensSpaces` — `( string arg1` extra space
- `BadSemicolonSpaces` — `i<arg2;i++`
- `BadSpacesAfterKeyword` — `if(`, `for(`, `foreach(`, `while(`
- `BadSymbolSpaces` — `i=0;i<arg2;i++` no spaces around operators
- `BadIndent` / `WrongIndentSize` / `MissingIndent` — mixed indentation
- `ArrangeModifiersOrder` — `static public` instead of `public static`
- `ArrangeAttributes` — attributes on same line as field
- `EnforceIfStatementBraces` / `EnforceForStatementBraces` / `EnforceForeachStatementBraces` / `EnforceWhileStatementBraces` — missing braces
- `MultipleStatementsOnOneLine` — two statements on one line
- `MultipleTypeMembersOnOneLine` — two methods on one line
- `RedundantBlankLines` — double blank line
- `MissingBlankLines` — no blank line between methods
- `MultipleSpaces` — double spaces
- `IncorrectBlankLinesNearBraces` — blank lines near braces
- `MissingSpace` / `RedundantSpace` — throughout

#### Phase 05 — Status & Errors (`05-status-errors.test.ts`)

| # | Test | Verification |
|---|------|-------------|
| 16 | Status reports full diagnostics | `unity_status` → editor running, bridge ready, Unity version, bridge version, last recompile time |
| 17 | Invalid project path | Call `unity_recompile` with nonexistent path → returns meaningful error, no crash |

### File Structure

```
__tests__/e2e/
├── global-setup.ts              # Find Unity, create project, git init, tag, open editor
├── global-teardown.ts           # Close Unity, delete project
├── helpers/
│   ├── mcp-client.ts            # MCP Client + StdioClientTransport wrapper
│   ├── unity.ts                 # findLatestUnityVersion(), createProject(), openEditor(), triggerRefresh(), waitForProcess(), closeUnity()
│   ├── fixtures.ts              # C# source string generators
│   └── state.ts                 # Read/write shared state (projectPath, unityVersion, pid) via temp JSON
├── 01-bridge-lifecycle.test.ts
├── 02-recompile.test.ts
├── 03-tests.test.ts
├── 04-lint.test.ts
└── 05-status-errors.test.ts
```

### Helpers

**`state.ts`** — Global setup writes `{ projectPath, unityVersion, unityPid }` to a JSON file in `os.tmpdir()`. Tests read it in `beforeAll`.

**`mcp-client.ts`**:
- `createMcpClient()` — spawns `node dist/server.mjs`, connects via `StdioClientTransport`, returns `{ client, callTool(name, args) }`
- `callTool` returns the MCP tool result content (text)
- `closeMcpClient()` — disconnect + kill child process

**`unity.ts`**:
- `findLatestUnityVersion()` — scan `/Applications/Unity/Hub/Editor/`, semver sort, return latest version string
- `createUnityProject(unityBinaryPath, projectDir)` — run `-createProject -quit -batchmode`, wait for exit
- `openUnityEditor(unityAppPath, projectDir)` — `open -a` in non-batch mode
- `waitForUnityProcess(projectDir, timeoutMs)` — poll `ps aux` for Unity matching project path
- `triggerOsascriptRefresh()` — send `Cmd+R` via osascript (same pattern as `applescript.ts`)
- `closeUnity(pid)` — kill process

**`fixtures.ts`** — pure functions returning C# source strings:
- `simpleMonoBehaviour(className)` — valid Unity script
- `compileErrorScript()` — C# with syntax error
- `passingEditModeTest(className, category?)` — `[Test]` method that passes, optional `[Category]`
- `failingEditModeTest(className)` — `[Test]` with `Assert.Fail()`
- `badlyFormattedScript()` — lint violation fixture (see Phase 04)

### Vitest Configuration

**`vitest.e2e.config.ts`**:
- `globalSetup` → `__tests__/e2e/global-setup.ts` and `__tests__/e2e/global-teardown.ts`
- `testTimeout: 300_000` (5 min per test)
- `hookTimeout: 600_000` (10 min for global setup)
- `sequence.concurrent: false` — strictly sequential
- `fileParallelism: false` — one phase at a time
- `bail: 1` within each file — stop on first failure
- Test files sorted alphabetically (numbered prefixes control order)
- `include: ['__tests__/e2e/**/*.test.ts']`

**npm script**: `"test:e2e": "vitest run --config vitest.e2e.config.ts"`

### Assertions

| Tool | Key assertions |
|------|---------------|
| `unity_recompile` | `isError` flag, text contains "success"/"skipped"/"error", compilation errors have file/line when expected |
| `unity_status` | Parsed fields: `editorRunning`, `bridgeReady`, `unityVersion`, `bridgeVersion` |
| `unity_list_tests` | Test count, test names present |
| `unity_run_tests` | `passCount`, `failCount`, summary text |
| `unity_test_results` | `runId` matches, staleness flag, result details |
| `unity_lint` | `filesLinted > 0`, read file after lint and verify formatting improvements |

### Timeouts

| Scope | Timeout |
|-------|---------|
| Global setup (project creation + Unity launch) | 600s (10 min) |
| Global teardown | 120s (2 min) |
| Individual test | 300s (5 min) |
| MCP tool call (within test) | Inherits from bridge config: 120s recompile, 300s tests |

### Affected Files

| File | Change |
|------|--------|
| **New: `vitest.e2e.config.ts`** | E2E-specific vitest configuration |
| **New: `__tests__/e2e/global-setup.ts`** | Unity project creation + editor launch |
| **New: `__tests__/e2e/global-teardown.ts`** | Unity close + project cleanup |
| **New: `__tests__/e2e/helpers/mcp-client.ts`** | MCP SDK client wrapper |
| **New: `__tests__/e2e/helpers/unity.ts`** | Unity process management utilities |
| **New: `__tests__/e2e/helpers/fixtures.ts`** | C# test fixture generators |
| **New: `__tests__/e2e/helpers/state.ts`** | Shared state for global setup ↔ tests |
| **New: `__tests__/e2e/01-bridge-lifecycle.test.ts`** | Bridge install, status, version update |
| **New: `__tests__/e2e/02-recompile.test.ts`** | Skip, success, error, fix |
| **New: `__tests__/e2e/03-tests.test.ts`** | List, run, filter, results, stale |
| **New: `__tests__/e2e/04-lint.test.ts`** | Format violations → lint cleanup |
| **New: `__tests__/e2e/05-status-errors.test.ts`** | Diagnostics, invalid path |
| `package.json` | Add `"test:e2e"` script |
