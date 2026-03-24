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

internal static void RegisterListTests()
{
    ClaudeBridgeBase.RegisterAction("list_tests", HandleListTests);
}

private static void HandleListTests(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
{
    ClaudeBridgeBase.MarkBusy(request.requestId);
    try
    {
        TestRunPayload filters = null;
        if (!string.IsNullOrEmpty(request.payload))
            filters = JsonUtility.FromJson<TestRunPayload>(request.payload);

        var filter = BuildFilter(filters);

        var api = ScriptableObject.CreateInstance<TestRunnerApi>();
        // RetrieveTestList is async via callback
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

Note: `RetrieveTestList` returns the full test tree. `CollectLeafTests` walks it recursively, collecting non-suite nodes. `FilterTestEntries` applies category/group/assembly matching to mirror what Unity's `Filter` does for execution.

Since `RetrieveTestList` doesn't accept a `Filter` object (only `Execute` does), the list handler must apply filtering manually. The `BuildFilter` method still serves as the canonical definition of filter semantics for `run_tests`, and `FilterTestEntries` mirrors its behavior for listing.

### Bridge Protocol Changes

#### New action: `list_tests`

Added to the `BridgeRequest.action` union type:

```typescript
action: "recompile" | "bootstrap_handshake" | "run_tests" | "list_tests";
```

#### New status state: `list_tests_finished`

Added to the `BridgeStatus.state` union type.

#### New field on `BridgeStatus`: `testList`

```typescript
testList?: TestListResult;
```

Where:

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
- `templates/ClaudeTestHandler.cs` — extract `BuildFilter`, add `HandleListTests` + `CollectLeafTests` + `FilterTestEntries`, register `list_tests` action
- `src/lib/bridge/types.ts` — add `TestDiscoveryFilters`, `TestResultFilters`, `TestListEntry`, `TestListResult`; rename `TestRunPayload` to `TestDiscoveryFilters`; add `list_tests` to action union; add `list_tests_finished` to state union; add `testList` to `BridgeStatus`
- `src/core/types.ts` — add `ListTestsResult` type
- `src/core/test.ts` — update `RunTestsOptions` to use `TestDiscoveryFilters`; update imports
- `src/core/test-results.ts` — update `GetTestResultsOptions` to use `TestResultFilters`; update imports
- `src/mcp/server.ts` — add `unity_list_tests` tool registration; import `listTests`

### Template version bump
- Bridge templates remain at version 4 (no base protocol change) but `ClaudeTestHandler.cs` version bumps to 5

## Testing Strategy

### Unit tests
- `__tests__/core/list-tests.test.ts` — mock bridge responses, verify formatting with/without filters
- `__tests__/core/test.test.ts` — verify existing tests still pass after `TestDiscoveryFilters` rename
- `__tests__/core/test-results.test.ts` — verify existing tests still pass after `TestResultFilters` rename

### MCP tests
- `__tests__/mcp/server.test.ts` — add `unity_list_tests` tool registration test

### Type enforcement verification
- Ensure `TestDiscoveryFilters` cannot be used where `TestResultFilters` is expected and vice versa (compile-time check)
