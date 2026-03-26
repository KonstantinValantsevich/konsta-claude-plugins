// ClaudeSearchHandler Version: 1
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Search;
using UnityEngine;

internal static class ClaudeSearchHandler
{
    [Serializable]
    private class SearchRequestPayload
    {
        public string query;
        public int limit = 100;
    }

    [Serializable]
    private class SearchResultEntry
    {
        public string id;
        public string label;
        public int score;
    }

    [Serializable]
    private class SearchResultList
    {
        public List<SearchResultEntry> items;
    }

    internal static void Register()
    {
        ClaudeBridgeBase.RegisterAction("search_assets", HandleSearchAssets);
    }

    private static void HandleSearchAssets(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        SearchContext context = null;
        try
        {
            var payload = new SearchRequestPayload();
            if (!string.IsNullOrEmpty(request.payload))
                payload = JsonUtility.FromJson<SearchRequestPayload>(request.payload);

            if (string.IsNullOrEmpty(payload.query))
            {
                ClaudeBridgeBase.WriteSearchStatus(request, "completed", true, "Empty query", "[]");
                ClaudeBridgeBase.FinalizeRequest(request);
                return;
            }

            int limit = Mathf.Clamp(payload.limit, 1, 500);

            context = SearchService.CreateContext("asset", payload.query);

            SearchService.Request(context, (SearchContext ctx, IList<SearchItem> items) =>
            {
                try
                {
                    var results = new List<SearchResultEntry>();

                    // Items are already sorted by score from SearchService
                    int count = 0;
                    foreach (var item in items)
                    {
                        if (count >= limit) break;

                        string itemLabel = null;
                        try { itemLabel = item.GetLabel(ctx, true); } catch { }

                        results.Add(new SearchResultEntry
                        {
                            id = item.id ?? string.Empty,
                            label = itemLabel ?? item.id ?? string.Empty,
                            score = item.score,
                        });
                        count++;
                    }

                    // Serialize as JSON array string
                    // JsonUtility doesn't serialize List<T> directly at top level,
                    // so wrap in a helper and extract the array
                    var wrapper = new SearchResultList { items = results };
                    string json = JsonUtility.ToJson(wrapper, false);

                    // Extract just the array: {"items":[...]} -> [...]
                    string arrayJson = "[]";
                    int startIdx = json.IndexOf('[');
                    int endIdx = json.LastIndexOf(']');
                    if (startIdx >= 0 && endIdx > startIdx)
                        arrayJson = json.Substring(startIdx, endIdx - startIdx + 1);

                    ClaudeBridgeBase.WriteSearchStatus(
                        request, "completed", true,
                        results.Count + " asset(s) found",
                        arrayJson
                    );
                }
                catch (Exception ex)
                {
                    ClaudeBridgeBase.WriteStatus(request, "failed", false, false,
                        "Search failed: " + ex.Message);
                }
                finally
                {
                    if (context != null)
                    {
                        context.Dispose();
                        context = null;
                    }
                    ClaudeBridgeBase.FinalizeRequest(request);
                }
            });
        }
        catch (Exception ex)
        {
            if (context != null)
            {
                context.Dispose();
                context = null;
            }
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false,
                "Search failed: " + ex.Message);
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }
}
