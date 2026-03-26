import { describe, it, expect } from "vitest";
import type { SearchPayload, SearchResultEntry, BridgeAction } from "../../../src/lib/bridge/types.js";

describe("search bridge types", () => {
  it("SearchPayload has query and limit fields", () => {
    const payload: SearchPayload = { query: "t:prefab", limit: 100 };
    expect(payload.query).toBe("t:prefab");
    expect(payload.limit).toBe(100);
  });

  it("SearchResultEntry has id, label, score fields", () => {
    const entry: SearchResultEntry = { id: "Assets/Foo.prefab", label: "Foo", score: 0 };
    expect(entry.id).toBe("Assets/Foo.prefab");
  });

  it("BridgeAction includes search_assets", () => {
    const action: BridgeAction = "search_assets";
    expect(action).toBe("search_assets");
  });
});
