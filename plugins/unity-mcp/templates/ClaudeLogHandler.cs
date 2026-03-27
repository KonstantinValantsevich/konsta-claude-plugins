// ClaudeLogHandler Version: 1
using System;
using UnityEngine;

internal static class ClaudeLogHandler
{
    [Serializable]
    private class LogRequestPayload
    {
        public int cursor = -1;
        public int limit = 100;
        public string filter;
        public string search;
    }

    internal static void Register()
    {
        ClaudeBridgeBase.RegisterAction("get_logs", HandleGetLogs);
        ClaudeBridgeBase.RegisterAction("get_console", HandleGetConsole);
    }

    private static void HandleGetLogs(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        try
        {
            var payload = new LogRequestPayload();
            if (!string.IsNullOrEmpty(request.payload))
                payload = JsonUtility.FromJson<LogRequestPayload>(request.payload);

            int limit = Mathf.Clamp(payload.limit, 1, 100);

            ClaudeLogCollector.LogsResponse response;
            if (payload.cursor < 0)
            {
                // No cursor provided — subscribe from now (return current cursor, zero entries)
                int currentCursor = ClaudeLogCollector.GetCurrentCursor();
                response = new ClaudeLogCollector.LogsResponse
                {
                    entries = new System.Collections.Generic.List<ClaudeLogCollector.LogEntry>(),
                    nextCursor = currentCursor,
                    totalBuffered = ClaudeLogCollector.GetBufferedCount(),
                    dropped = 0,
                };
            }
            else
            {
                response = ClaudeLogCollector.GetEntriesSinceCursor(payload.cursor, limit, payload.filter, payload.search);
            }

            string json = JsonUtility.ToJson(response);
            ClaudeBridgeBase.WriteLogsStatus(request, "completed", true, response.entries.Count + " log entry(ies)", json);
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "get_logs failed: " + ex.Message);
        }
        finally
        {
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }

    private static void HandleGetConsole(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        try
        {
            var payload = new LogRequestPayload();
            if (!string.IsNullOrEmpty(request.payload))
                payload = JsonUtility.FromJson<LogRequestPayload>(request.payload);

            int limit = Mathf.Clamp(payload.limit, 1, 100);

            var response = ClaudeLogCollector.GetRecentEntries(limit, payload.filter, payload.search);

            string json = JsonUtility.ToJson(response);
            ClaudeBridgeBase.WriteLogsStatus(request, "completed", true, response.entries.Count + " log entry(ies)", json);
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "get_console failed: " + ex.Message);
        }
        finally
        {
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }
}
