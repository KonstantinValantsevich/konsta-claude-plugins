# Unity Asset Search MCP Resource

## Overview

Add an MCP resource to the Unity MCP plugin that exposes Unity's built-in Search system (`UnityEditor.Search`) for asset discovery. This is the first MCP resource in the plugin — all existing functionality uses tools.

## Motivation

Claude currently has no way to search for assets (prefabs, materials, textures, ScriptableObjects, etc.) within a Unity project. Unity's Search API provides powerful indexed queries with type filters, property comparisons, glob patterns, and relevance scoring. Exposing this as an MCP resource lets Claude discover assets by name, type, or properties without manual path guessing.

## Design

### MCP Resources

#### 1. Resource Template: `unity://assets/search/{query}`

A dynamic resource template that executes a Unity Search query and returns matching assets.

**URI format:** `unity://assets/search/{query}?limit={limit}`
- `query` (string, required) — Unity Search syntax query, URI-encoded. Example: `unity://assets/search/t%3Aprefab%20enemy` for `t:prefab enemy`
- `limit` (number, optional, default: 100, max: 500) — passed as query string parameter

**Response format:** `application/json`

```json
[
  { "id": "Assets/Prefabs/Enemy.prefab", "label": "Enemy", "score": 0 },
  { "id": "Assets/Materials/Wood.mat", "label": "Wood", "score": 10 }
]
```

- `id` — Asset path (from `SearchItem.id`)
- `label` — Display name (from `SearchItem.label`)
- `score` — Relevance score, lower = more relevant (from `SearchItem.score`)

Results are sorted by score (most relevant first) and capped at `limit`. An empty search returns `[]` (not an error).

**Description (on the resource template registration):**

```
Search Unity project assets. Returns JSON array of {id, label, score}.
Common query syntax:
  - By name: "enemy", "player*"
  - By type: "t:prefab", "t:material", "t:texture", "t:scene"
  - By label: "l:mylabel"
  - By extension: "ext:png", "ext:cs"
  - By directory: "dir:Assets/Prefabs"
  - Combined: "t:prefab enemy" (AND), "player or monster" (OR)
  - Exclude: "-t:scene" (NOT)
  - Prefab variants: "prefab:variant", "prefab:model"
Read unity://assets/search-syntax for full syntax reference.
```

#### 2. Static Resource: `unity://assets/search-syntax`

A static resource containing the full Unity Search query syntax reference. No bridge call needed — hardcoded in TypeScript.

**Content (text/markdown):**

```markdown
# Unity Asset Search Syntax Reference

## Filter Tokens

| Token | Description | Example |
|-------|-------------|---------|
| `t:` / `t=` | Type (partial/exact) | `t:prefab`, `t=Texture2D` |
| `l:` / `l=` | Label (partial/exact) | `l:arch`, `l=Wall` |
| `ref:` | References asset | `ref:Crystal`, `ref="Assets/Prefabs/Crystal.prefab"` |
| `ext:` | File extension | `ext:png`, `ext:cs` |
| `dir:` | Directory scope | `dir:Assets/Prefabs` |
| `name:` | File name | `name:laser` |
| `size` | File size (bytes) | `size>4096`, `size<=1024` |
| `age` | Days since modified | `age<3`, `age>30` |
| `a:` | Area | `a:assets`, `a:packages`, `a:all` |
| `prefab:` | Prefab type | `prefab:root`, `prefab:variant`, `prefab:model`, `prefab:modified` |
| `is:` | State filter | `is:subasset` |
| `missing:` | Missing refs | `missing:scripts` |

## Comparison Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `:` | Contains/partial | `t:texture` |
| `=` | Exact match | `t=Texture2D` |
| `!=` | Not equal | `filtermode!=0` |
| `>` | Greater than | `size>4096` |
| `<` | Less than | `age<3` |
| `>=` | Greater or equal | `width>=4096` |
| `<=` | Less or equal | `bounciness<=0.5` |

## Boolean Logic

| Syntax | Meaning | Example |
|--------|---------|---------|
| space | AND (implicit) | `t:texture volume` |
| `or` | OR | `player or monster` |
| `-` | Exclude | `-t:scene` |
| `()` | Grouping | `t:prefab (enemy or ally)` |
| `!` | Exact name match | `!stone` |

## Indexed Property Queries

When the project search index is built, serialized properties can be queried directly:
- Numeric: `health=2`, `bounciness>0.1`
- Boolean: `generatePath=true`
- String: `trait:indestru` (partial), `trait="tough but fair"` (exact)
- Color (hex): `color:ADA`, `color=ADADAD`
- Vector component: `bounds.x>1`, `acceleration.z=2`
- Object ref: `sprite:CharacterBody`
- Null check: `property=none`

## Query Flags

| Flag | Effect |
|------|--------|
| `+noResultsLimit` | Return all results (default cap ~2999) |
| `+fuzzy` | Fuzzy/approximate matching |

## Examples

- All prefabs: `t:prefab`
- Prefabs with "enemy" in name: `t:prefab enemy`
- Large textures: `t:texture size>1048576`
- Recently modified scripts: `ext:cs age<7`
- Prefab variants: `prefab:variant`
- Materials in specific folder: `t:material dir:Assets/Art/Materials`
- Assets referencing a specific prefab: `ref="Assets/Prefabs/Player.prefab"`
```

### C# Handler: `ClaudeSearchHandler.cs`

New template file installed alongside existing handlers at `Assets/Claude Bridge/Editor/`.

**Registration:** Action `"search_assets"` registered in `ClaudeBridgeBase.cs`.

**Request payload:**
```json
{
  "query": "t:prefab enemy",
  "limit": 100
}
```

**Implementation flow:**
1. Call `MarkBusy(request.requestId)` at handler entry
2. Parse payload — extract `query` string and `limit` (default 100, hard max 500)
3. Create search context: `SearchService.CreateContext("asset", query)`
4. Execute search via `SearchService.Request()` with async callback
5. On completion: sort results by `score`, take first `limit` items
6. Map each `SearchItem` to `{ id: item.id, label: item.label ?? item.GetLabel(), score: item.score }`
7. Serialize results array as JSON string — pass through existing `testResultsJson` parameter on `WriteStatus` (reusing the same wire field, see Bridge Protocol section)
8. Write terminal status `"completed"` via `WriteStatus`
9. Call `FinalizeRequest(request)` to release the queue

**Error handling:**
- Wrap steps 3-6 in try/finally — dispose `SearchContext` and call `FinalizeRequest` in all paths
- On exception: write `"failed"` status with error summary, then `FinalizeRequest`

**Considerations:**
- Scoped to `"asset"` provider only (no scene/hierarchy)
- Search runs on main thread (consistent with other handlers)
- Uses default `BRIDGE_STATUS_TIMEOUT_MS` timeout (search should be fast with indexed projects)
- `SearchContext` must be disposed in a finally block to prevent leaks

### TypeScript: Resource Registration in `server.ts`

Register two resources on the MCP server:

1. `server.resourceTemplate()` for `unity://assets/search/{query}` with optional `limit` parameter
2. `server.resource()` for `unity://assets/search-syntax` (static content)

**Read handler for the search template:**
1. Extract `query` (URI-decoded) and `limit` from the URI/params
2. Resolve `projectPath` (same auto-detection as existing tools)
3. Send bridge request with action `"search_assets"` and payload `{ query, limit }`
4. Wait for status via `waitForBridgeStatus()`
5. Parse search results from the `testResults` wire field in the status file (action-aware parsing)
6. Return as `application/json` content

### Bridge Protocol

Reuses existing file-based IPC. New additions:

**Request file** — same format, with:
- `action: "search_assets"`
- `payload: '{"query":"t:prefab enemy","limit":100}'`

**Status file** — reuses the existing `testResults` wire field for search results JSON:
- `testResults: '[{"id":"Assets/...","label":"...","score":0},...]'` (JSON string)

This reuses the existing `testResultsJson` parameter on `WriteStatus` rather than adding a new field. The TypeScript side distinguishes the content by checking the original action type — when action is `"search_assets"`, the `testResults` field is parsed as `SearchResult[]` instead of `TestResults`.

**Terminal state:** Reuses `"completed"` — no new terminal state needed. The existing `TERMINAL_STATES` set already includes it.

No protocol version bump needed — this is an additive change.

## Files Changed

| File | Change |
|------|--------|
| `src/mcp/server.ts` | Add resource template + static resource registration |
| `src/core/search.ts` | New file — search resource read handler logic (follows existing core module pattern: accepts `projectPath` + `logger`, calls `sendBridgeRequest`) |
| `src/lib/bridge/types.ts` | Add `"search_assets"` to `BridgeAction` union; generalize `BridgeRequest.payload` from `TestDiscoveryFilters` to `TestDiscoveryFilters \| SearchPayload`; add `SearchPayload` and `SearchResult` interfaces |
| `src/lib/bridge/request.ts` | Update `sendBridgeRequest` opts type to accept `SearchPayload`; add `"search_assets"` to `defaultTimeout` (uses `BRIDGE_STATUS_TIMEOUT_MS`) and `reasonForAction` |
| `templates/ClaudeBridgeBase.cs` | Register `"search_assets"` action handler |
| `templates/ClaudeSearchHandler.cs` | New file — C# search handler |

## Testing

- Unit tests for query parameter parsing and result mapping
- Integration test: mock bridge response with search results, verify JSON output
- E2E test: requires running Unity Editor with indexed project

## Out of Scope

- Scene/hierarchy search (`h:` provider)
- Deep property inspection of found assets (components, serialized values)
- Search expressions (`{count, sort, ...}` syntax) — works if Unity supports it, but not explicitly handled
- Custom search indexes
