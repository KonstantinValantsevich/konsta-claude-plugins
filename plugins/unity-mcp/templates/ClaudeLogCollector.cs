// ClaudeLogCollector Version: 1
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

internal static class ClaudeLogCollector
{
    private const int BufferCapacity = 1000;

    [Serializable]
    internal class LogEntry
    {
        public int id;
        public string type;
        public string message;
        public string stackTrace;
        public double timestamp;
    }

    [Serializable]
    internal class LogsResponse
    {
        public List<LogEntry> entries;
        public int nextCursor;
        public int totalBuffered;
        public int dropped;
    }

    private static readonly object Sync = new object();
    private static readonly LogEntry[] Buffer = new LogEntry[BufferCapacity];
    private static int _head;       // next write index (wraps)
    private static int _count;      // entries currently in buffer (max BufferCapacity)
    private static int _nextId = 1; // monotonically increasing

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    private static void ResetStatics()
    {
        lock (Sync)
        {
            Array.Clear(Buffer, 0, BufferCapacity);
            _head = 0;
            _count = 0;
            _nextId = 1;
        }
    }

    internal static void Initialize()
    {
        Application.logMessageReceivedThreaded -= OnLogMessageReceived;
        Application.logMessageReceivedThreaded += OnLogMessageReceived;
    }

    private static void OnLogMessageReceived(string message, string stackTrace, LogType logType)
    {
        lock (Sync)
        {
            var entry = new LogEntry
            {
                id = _nextId++,
                type = LogTypeToString(logType),
                message = message ?? string.Empty,
                stackTrace = stackTrace ?? string.Empty,
                timestamp = EditorApplication.timeSinceStartup,
            };

            Buffer[_head] = entry;
            _head = (_head + 1) % BufferCapacity;
            if (_count < BufferCapacity) _count++;
        }
    }

    /// <summary>
    /// Get entries where id > cursor, oldest first, up to limit.
    /// </summary>
    internal static LogsResponse GetEntriesSinceCursor(int cursor, int limit, string filter, string search)
    {
        lock (Sync)
        {
            var entries = new List<LogEntry>();
            int dropped = 0;

            if (_count == 0)
                return new LogsResponse { entries = entries, nextCursor = _nextId - 1, totalBuffered = 0, dropped = 0 };

            // Oldest entry in buffer
            int oldestIndex = _count < BufferCapacity ? 0 : _head;
            int oldestId = Buffer[oldestIndex].id;

            // Calculate dropped: entries that existed after cursor but fell off the buffer
            if (cursor > 0 && cursor < oldestId - 1)
                dropped = oldestId - 1 - cursor;

            // Walk buffer from oldest to newest
            for (int i = 0; i < _count && entries.Count < limit; i++)
            {
                int idx = (oldestIndex + i) % BufferCapacity;
                var entry = Buffer[idx];
                if (entry == null) continue;
                if (entry.id <= cursor) continue;
                if (!MatchesFilter(entry, filter, search)) continue;
                entries.Add(entry);
            }

            int lastId = entries.Count > 0 ? entries[entries.Count - 1].id : (_nextId - 1);
            return new LogsResponse
            {
                entries = entries,
                nextCursor = lastId,
                totalBuffered = _count,
                dropped = dropped,
            };
        }
    }

    /// <summary>
    /// Get last N entries, most recent first, then reverse to oldest-first output.
    /// </summary>
    internal static LogsResponse GetRecentEntries(int limit, string filter, string search)
    {
        lock (Sync)
        {
            var entries = new List<LogEntry>();

            if (_count == 0)
                return new LogsResponse { entries = entries, nextCursor = 0, totalBuffered = 0, dropped = 0 };

            // Walk backward from newest
            for (int i = _count - 1; i >= 0 && entries.Count < limit; i--)
            {
                int idx = (_count < BufferCapacity ? i : (_head - 1 - (_count - 1 - i) + BufferCapacity) % BufferCapacity);
                var entry = Buffer[idx];
                if (entry == null) continue;
                if (!MatchesFilter(entry, filter, search)) continue;
                entries.Add(entry);
            }

            // Reverse so output is oldest-first (most recent last)
            entries.Reverse();

            int lastId = entries.Count > 0 ? entries[entries.Count - 1].id : (_nextId - 1);
            return new LogsResponse
            {
                entries = entries,
                nextCursor = lastId,
                totalBuffered = _count,
                dropped = 0,
            };
        }
    }

    /// <summary>
    /// Returns the latest entry id (agent can "start fresh" without reading history).
    /// </summary>
    internal static int GetCurrentCursor()
    {
        lock (Sync)
        {
            return _nextId - 1;
        }
    }

    private static bool MatchesFilter(LogEntry entry, string filter, string search)
    {
        if (!string.IsNullOrEmpty(filter) && !string.Equals(entry.type, filter, StringComparison.OrdinalIgnoreCase))
            return false;
        if (!string.IsNullOrEmpty(search))
        {
            bool inMessage = entry.message != null && entry.message.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
            bool inStack = entry.stackTrace != null && entry.stackTrace.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0;
            if (!inMessage && !inStack) return false;
        }
        return true;
    }

    private static string LogTypeToString(LogType type)
    {
        switch (type)
        {
            case LogType.Error: return "Error";
            case LogType.Warning: return "Warning";
            case LogType.Log: return "Log";
            case LogType.Exception: return "Exception";
            case LogType.Assert: return "Assert";
            default: return "Log";
        }
    }
}
