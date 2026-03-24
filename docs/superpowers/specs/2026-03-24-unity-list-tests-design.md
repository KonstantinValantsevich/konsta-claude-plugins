# Unity List Tests MCP Tool

## Summary

Add a `unity_list_tests` MCP tool that discovers available Unity EditMode tests via the bridge, with optional filtering. Extract shared filter-building logic in C# and enforce type-level separation in TypeScript between discovery filters (category/group/assembly) and result filters (status/name).

## Motivation

Currently, the only way to know what tests exist is to run them (`unity_run_tests`). This tool enables:
- **Discovery**: see all available tests before committing to a run
- **Filter preview**: verify which tests a filter would match before executing

## Architecture

### Data Flow

#### `unity_list_tests` (new)

```
Claude → TS tool handler
  → detect project, ensure bridge ready
  → write request.json { action: "list_tests", payload: { categoryNames?, groupNames?, assemblyNames? } }
  → C# bridge picks it up
    → TestRunnerApi retrieves all EditMode tests via RetrieveTestList()
    → BuildFilter(payload) → Unity Filter object
    → Apply filter to enumerate matching tests
    → Write status-{id}.json { state: "list_tests_finished", testList: [...] }
  → TS polls status file, reads testList
  → Format & return flat list to Claude
```

No tests are executed. Enumeration + filter only.

#### `unity_run_tests` (existing — refactor only)

```
Claude → TS tool handler (unchanged)
  → write request.json { action: "run_tests", payload: { ... } }
  → C# bridge:
    → BuildFilter(payload) → same shared method
    → TestRunnerApi.Execute(settings with filter)
    → Write status-{id}.json { state: "tests_finished", testResults: {...} }
  → TS polls, stores, formats (unchanged)
```

The only C# change: extract the filter-building code into the shared `BuildFilter` method. Behavior is identical.

#### `unity_test_results` (existing — type refactor only)

```
Claude → TS tool handler
  → Load stored test run from disk
  → Apply TestResultFilters (statusFilter, nameFilter) — TS-side, unchanged logic
  → Format & return
```

No bridge involved. The filters here (status + name regex on results) are fundamentally different from discovery filters (category/group/assembly). Type refactor only — no behavior change.

### Type-Level Enforcement (TypeScript)

Two distinct filter types prevent accidental client-side filtering on discovery axes:

```typescript
// src/lib/bridge/types.ts

/** Filters for test discovery/execution — only flow into bridge requests */
export interface TestDiscoveryFilters {
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
}

/** Filters for post-hoc result viewing — only used on stored results */
export interface TestResultFilters {
  statusFilter?: "passed" | "failed" | "skipped";
  nameFilter?: string;
}
```

`TestRunPayload` is replaced by `TestDiscoveryFilters` (same shape, renamed for clarity).

The existing `BridgeRequest.payload` field becomes typed as `TestDiscoveryFilters` (for `run_tests` and `list_tests` actions).

### Shared `BuildFilter` in C# Bridge

Extract from `ClaudeTestHandler.HandleRunTests` into a shared static method:

```csharp
// In a new ClaudeTestFilterBuilder.cs or as a static method on ClaudeTestHandler
internal static Filter BuildFilter(TestRunPayload filters)
{
    var filter = new Filter { testMode = TestMode.EditMode };
    if (filters != null)
    {
        if (filters.categoryNames != null && filters.categoryNames.Length > 0)
            filter.categoryNames = filters.categoryNames;
        if (filters.groupNames != null && filters.groupNames.Length > 0)
            filter.groupNames = filters.groupNames;
        if (filters.assemblyNames != null && filters.assemblyNames.Length > 0)
            filter.assemblyNames = filters.assemblyNames;
    }
    return filter;
}
```

Used by both `ClaudeTestHandler.HandleRunTests` and the new `HandleListTests`.

### New `list_tests` C# Handler

Registered as a new action on `ClaudeBridgeBase`. Uses `TestRunnerApi.RetrieveTestList()` with the shared `BuildFilter`, then walks the test tree to collect leaf tests into a flat list.

```csharp
// ClaudeTestHandler.cs — new handler

[Serializable]
private class TestListEntry
{
    public string fullName;
    public string name;
    public string[] categories;
    public string assembly;
}

[Serializable]
private class TestListPayload
{
    public int totalCount;
    public int matchedCount;
    public List<TestListEntry> tests;
}

// Registered inside the existing Register() method alongside "run_tests":
//   ClaudeBridgeBase.RegisterAction("list_tests", HandleListTests);

private static void HandleListTests(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
{
    ClaudeBridgeBase.MarkBusy(request.requestId);
    try
    {
        TestRunPayload filters = null;
        if (!string.IsNullOrEmpty(request.payload))
            filters = JsonUtility.FromJson<TestRunPayload>(request.payload);

        var api = ScriptableObject.CreateInstance<TestRunnerApi>();
        // RetrieveTestList is async via callback — callback fires on the main thread
        // (Unity's TestRunnerApi guarantees main-thread callbacks)
        api.RetrieveTestList(TestMode.EditMode, (testRoot) =>
        {
            var allTests = new List<TestListEntry>();
            CollectLeafTests(testRoot, allTests);

            // Apply filter client-side for list (RetrieveTestList doesn't accept Filter)
            var matched = FilterTestEntries(allTests, filters);

            var payload = new TestListPayload
            {
                totalCount = allTests.Count,
                matchedCount = matched.Count,
                tests = matched,
            };

            ClaudeBridgeBase.WriteStatus(
                request, "list_tests_finished", false, true,
                matched.Count + " test(s) matched out of " + allTests.Count + " total",
                null,
                JsonUtility.ToJson(payload, true)
            );
            ClaudeBridgeBase.FinalizeRequest(request);
        });
    }
    catch (Exception ex)
    {
        ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "List tests failed: " + ex.Message);
        ClaudeBridgeBase.FinalizeRequest(request);
    }
}
```

**`CollectLeafTests`** walks the `ITestAdaptor` tree recursively. For each node: if `IsSuite` is false, it's a leaf test — collect `FullName`, `Name`, `Categories` (from `ITestAdaptor.Categories`), and the assembly name (from the root suite's `Name` or `ITestAdaptor.TypeInfo.Assembly.GetName().Name`). If `IsSuite` is true, recurse into `Children`.

**`FilterTestEntries`** mirrors what Unity's `Filter` does for execution:
- `categoryNames`: test matches if it has at least one of the specified categories (OR logic)
- `groupNames`: test matches if its `fullName` matches at least one regex pattern (OR logic) — same regex semantics as Unity's `Filter.groupNames`
- `assemblyNames`: test matches if its assembly is in the list (OR logic)
- When multiple filter types are specified, they combine with AND logic (test must match all specified filter types)
- When no filters are specified, all tests match

Since `RetrieveTestList` doesn't accept a `Filter` object (only `Execute` does), the list handler must apply filtering manually. `FilterTestEntries` is carefully written to match Unity's `Filter` semantics so that `list_tests` previews match `run_tests` results.

### Bridge Protocol Changes

#### New action: `list_tests`

Added to the `BridgeRequest.action` union type:

```typescript
action: "recompile" | "bootstrap_handshake" | "run_tests" | "list_tests";
```

The `payload` field on `BridgeRequest` is renamed from `TestRunPayload` to `TestDiscoveryFilters` — same shape, same JSON wire format, purely a type rename. The C# side is unchanged (it reads `payload` as a `string` and deserializes with `JsonUtility.FromJson`).

#### New status state: `list_tests_finished`

Added to the `BridgeStatus.state` union type.

**Also added to `TERMINAL_STATES` in `src/lib/bridge/ipc.ts`** — without this, `waitForBridgeStatus` would never return the list result.

#### Serialization: reuse `testResults` string field

The C# `StatusPayload` has a `testResults` string field used by `run_tests` to pass JSON. The `list_tests` handler reuses this same field — `WriteStatus` already accepts a `testResultsJson` parameter. The TS `readBridgeStatus` already re-parses `testResults` from a JSON string to an object.

On the TS side, `BridgeStatus` gets a new `testList` field:

```typescript
testList?: TestListResult;
```

The `readBridgeStatus` function is updated to parse `testResults` into `testList` when the state is `list_tests_finished`:

```typescript
if (typeof raw.testResults === "string" && raw.testResults) {
  try {
    const parsed = JSON.parse(raw.testResults as string);
    if (raw.state === "list_tests_finished") {
      raw.testList = parsed;
    } else {
      raw.testResults = parsed;
    }
  } catch {
    // Leave as-is if parsing fails
  }
}
```

This means: no changes to `ClaudeBridgeBase.StatusPayload` or `WriteStatus` signature in C#. The TS side routes the JSON blob to the correct typed field based on state.

#### New TS types

```typescript
export interface TestListEntry {
  fullName: string;
  name: string;
  categories: string[];
  assembly: string;
}

export interface TestListResult {
  totalCount: number;
  matchedCount: number;
  tests: TestListEntry[];
}
```

### New Core Module: `src/core/list-tests.ts`

```typescript
export interface ListTestsOptions {
  projectPath: string;
  categoryNames?: string[];
  groupNames?: string[];
  assemblyNames?: string[];
  logger?: Logger;
}

export interface ListTestsResult {
  formatted: string;
  totalCount: number;
  matchedCount: number;
}
```

Follows the same pattern as `src/core/test.ts`: check Unity running, check bridge ready, write request, poll status, format result.

### MCP Tool Registration

```typescript
server.tool(
  "unity_list_tests",
  "List available Unity EditMode tests. Returns test names, categories, and assemblies. Supports filtering by category, class/namespace (regex), and assembly — use to preview which tests a filter matches before running.",
  {
    projectPath: z.string().describe("Unity project root path"),
    categoryNames: z.array(z.string()).optional().describe("NUnit [Category] tags to filter by"),
    groupNames: z.array(z.string()).optional().describe("Regex patterns for namespace/class/test name filtering"),
    assemblyNames: z.array(z.string()).optional().describe("Assembly names to filter (without .dll)"),
  },
  async ({ projectPath, categoryNames, groupNames, assemblyNames }) => {
    const result = await listTests({ projectPath, categoryNames, groupNames, assemblyNames, logger: stderrLogger });
    return {
      content: [{ type: "text" as const, text: result.formatted }],
    };
  },
);
```

### Output Format

When called without filters (full discovery):

```
Available EditMode tests (42 total):

  Assembly.Tests
    Namespace.FixtureA.TestOne [CategoryA]
    Namespace.FixtureA.TestTwo [CategoryA, CategoryB]
    Namespace.FixtureB.TestThree

  OtherAssembly.Tests
    Other.FixtureC.TestFour
```

When called with filters (preview):

```
Matched 3 of 42 EditMode tests (filter: categoryNames=["CategoryA"]):

  Assembly.Tests
    Namespace.FixtureA.TestOne [CategoryA]
    Namespace.FixtureA.TestTwo [CategoryA, CategoryB]

  OtherAssembly.Tests
    Other.FixtureC.TestFour [CategoryA]
```

Tests are grouped by assembly for readability. Categories shown in brackets after each test name.

## Files Changed

### New files
- `src/core/list-tests.ts` — core list tests logic (bridge request + format)

### Modified files
- `templates/ClaudeTestHandler.cs` — extract `BuildFilter`, add `HandleListTests` + `CollectLeafTests` + `FilterTestEntries`, register `list_tests` action in existing `Register()` method
- `src/lib/bridge/types.ts` — add `TestDiscoveryFilters`, `TestResultFilters`, `TestListEntry`, `TestListResult`; rename `TestRunPayload` to `TestDiscoveryFilters`; add `list_tests` to action union; add `list_tests_finished` to state union; add `testList` to `BridgeStatus`
- `src/lib/bridge/ipc.ts` — add `list_tests_finished` to `TERMINAL_STATES`; update `readBridgeStatus` to route parsed JSON to `testList` when state is `list_tests_finished`
- `src/core/types.ts` — add `ListTestsResult` type
- `src/core/test.ts` — update `RunTestsOptions` to use `TestDiscoveryFilters`; update imports
- `src/core/test-results.ts` — update `GetTestResultsOptions` to use `TestResultFilters`; update imports
- `src/mcp/server.ts` — add `unity_list_tests` tool registration; import `listTests`

### Template version bump
- Bridge templates remain at version 4 (no base protocol change) but `ClaudeTestHandler.cs` version comment bumps to 5 (file-level marker only, does not affect bridge handshake — `BRIDGE_VERSION` in `ClaudeBridgeBase` stays "4")

## Testing Strategy

### Unit tests
- `__tests__/core/list-tests.test.ts` — mock bridge responses, verify formatting with/without filters
- `__tests__/core/test.test.ts` — verify existing tests still pass after `TestDiscoveryFilters` rename
- `__tests__/core/test-results.test.ts` — verify existing tests still pass after `TestResultFilters` rename

### MCP tests
- `__tests__/mcp/server.test.ts` — add `unity_list_tests` tool registration test

### Type enforcement verification
- Ensure `TestDiscoveryFilters` cannot be used where `TestResultFilters` is expected and vice versa (compile-time check)
