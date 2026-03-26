// ClaudeBridgeBase Version: 4
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
internal static class ClaudeBridgeBase
{
    private const int ProtocolVersion = 1;
    private const string BridgeVersion = "4";
    private const string RequestFilePrefix = "request-";
    private const string StatusFilePrefix = "status-";
    private const string ReadyFileName = "bridge-ready.json";
    private const long StaleThresholdMs = 5 * 60 * 1000; // 5 minutes

    [Serializable]
    internal class RequestPayload
    {
        public int protocolVersion;
        public string requestId;
        public long requestedAtUnixMs;
        public string projectPath;
        public string action;
        public string reason;
        public string source;
        public string payload;
    }

    [Serializable]
    internal class ErrorPayload
    {
        public string assembly;
        public string file;
        public int line;
        public int column;
        public string message;
        public string type;
    }

    [Serializable]
    internal class StatusPayload
    {
        public int protocolVersion;
        public string requestId;
        public string bridgeVersion;
        public string projectPath;
        public string state;
        public long createdAtUnixMs;
        public long updatedAtUnixMs;
        public bool didCompile;
        public bool isSuccess;
        public List<ErrorPayload> errors;
        public string summary;
        public string testResults;
        public string searchResults;
    }

    [Serializable]
    internal class ReadyPayload
    {
        public int protocolVersion;
        public string bridgeVersion;
        public string projectPath;
        public long readyAtUnixMs;
    }

    internal delegate void ActionHandler(RequestPayload request, long createdAtUnixMs);

    private static readonly object Sync = new object();
    private static FileSystemWatcher _watcher;
    private static bool _requestCheckQueued;
    private static Timer _loopKickTimer;
    private static readonly HashSet<string> ProcessedRequestIds = new HashSet<string>();
    private static readonly Dictionary<string, ActionHandler> ActionHandlers = new Dictionary<string, ActionHandler>();
    private static readonly List<RequestPayload> RequestQueue = new List<RequestPayload>();
    private static readonly HashSet<string> AcknowledgedRequestIds = new HashSet<string>();

    internal static string ProjectPath => Directory.GetParent(Application.dataPath).FullName;
    internal static string IpcDir => Path.Combine(ProjectPath, "Library", "ClaudeHookIPC");
    private static string ReadyPath => Path.Combine(IpcDir, ReadyFileName);

    private static string _busyRequestId;

    static ClaudeBridgeBase()
    {
        try
        {
            Directory.CreateDirectory(IpcDir);
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.update += OnEditorUpdate;

            ClaudeRecompileHandler.Register();
            ClaudeTestHandler.Register();
            ClaudeSearchHandler.Register();

            StartWatcher();
            WriteReady();
            EnsureLoopKickTimerRunning();
            TryKickEditorLoop();
            ProcessRequestOnMainThread();
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase init failed: " + ex);
        }
    }

    internal static void RegisterAction(string action, ActionHandler handler)
    {
        ActionHandlers[action] = handler;
    }

    internal static void MarkBusy(string requestId)
    {
        _busyRequestId = requestId;
        EnsureLoopKickTimerRunning();
    }

    internal static void MarkFree()
    {
        _busyRequestId = null;
        UpdateLoopKickTimerState();
        WriteReady();
    }

    internal static void WriteStatus(RequestPayload request, string state, bool didCompile, bool isSuccess, string summary, List<ErrorPayload> errors = null, string testResultsJson = null)
    {
        if (request == null || string.IsNullOrEmpty(request.requestId))
            return;

        var payload = new StatusPayload
        {
            protocolVersion = ProtocolVersion,
            requestId = request.requestId,
            bridgeVersion = BridgeVersion,
            projectPath = ProjectPath,
            state = state,
            createdAtUnixMs = NowUnixMs(),
            updatedAtUnixMs = NowUnixMs(),
            didCompile = didCompile,
            isSuccess = isSuccess,
            errors = errors ?? new List<ErrorPayload>(),
            summary = summary ?? string.Empty,
            testResults = testResultsJson,
        };

        string json = JsonUtility.ToJson(payload, true);
        if (errors != null && errors.Count > 0)
            Debug.Log($"[ClaudeBridge] WriteStatus: errorCount={errors.Count} json.contains(\"file\")={json.Contains("file")} jsonLength={json.Length}\n[ClaudeBridge] JSON snippet (errors): {(json.Length > 500 ? json.Substring(0, 500) : json)}");

        string path = Path.Combine(IpcDir, "status-" + request.requestId + ".json");
        TryWriteJsonAtomic(path, json);
    }

    internal static void WriteSearchStatus(RequestPayload request, string state, bool isSuccess, string summary, string searchResultsJson)
    {
        if (request == null || string.IsNullOrEmpty(request.requestId))
            return;

        var payload = new StatusPayload
        {
            protocolVersion = ProtocolVersion,
            requestId = request.requestId,
            bridgeVersion = BridgeVersion,
            projectPath = ProjectPath,
            state = state,
            createdAtUnixMs = NowUnixMs(),
            updatedAtUnixMs = NowUnixMs(),
            didCompile = false,
            isSuccess = isSuccess,
            errors = new List<ErrorPayload>(),
            summary = summary ?? string.Empty,
            searchResults = searchResultsJson,
        };

        string json = JsonUtility.ToJson(payload, true);
        string path = Path.Combine(IpcDir, "status-" + request.requestId + ".json");
        TryWriteJsonAtomic(path, json);
    }

    internal static void FinalizeRequest(RequestPayload request)
    {
        if (request == null) return;
        ProcessedRequestIds.Add(request.requestId);
        AcknowledgedRequestIds.Remove(request.requestId);
        TryDeleteRequestFile(request.requestId);
        MarkFree();
        QueueRequestCheck();
    }

    internal static long NowUnixMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static void StartWatcher()
    {
        try
        {
            if (_watcher != null)
            {
                _watcher.EnableRaisingEvents = false;
                _watcher.Created -= OnRequestFileEvent;
                _watcher.Changed -= OnRequestFileEvent;
                _watcher.Renamed -= OnRequestFileRenamed;
                _watcher.Dispose();
                _watcher = null;
            }

            _watcher = new FileSystemWatcher(IpcDir, "request-*.json")
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.Size,
                IncludeSubdirectories = false,
                EnableRaisingEvents = true,
            };
            _watcher.Created += OnRequestFileEvent;
            _watcher.Changed += OnRequestFileEvent;
            _watcher.Renamed += OnRequestFileRenamed;
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase watcher failed: " + ex);
        }
    }

    private static void OnRequestFileEvent(object sender, FileSystemEventArgs e) { QueueRequestCheck(); }
    private static void OnRequestFileRenamed(object sender, RenamedEventArgs e) { QueueRequestCheck(); }

    private static void QueueRequestCheck()
    {
        lock (Sync)
        {
            if (_requestCheckQueued)
            {
                TryKickEditorLoop();
                return;
            }
            _requestCheckQueued = true;
        }
        EnsureLoopKickTimerRunning();
        TryKickEditorLoop();
        EditorApplication.delayCall += ProcessRequestOnMainThread;
    }

    private static void ProcessRequestOnMainThread()
    {
        lock (Sync) { _requestCheckQueued = false; }

        long now = NowUnixMs();
        List<RequestPayload> scanned = ScanRequestFiles();

        foreach (var request in scanned)
        {
            if (!string.Equals(request.projectPath ?? string.Empty, ProjectPath, StringComparison.Ordinal))
                continue;
            if (string.IsNullOrEmpty(request.requestId)) continue;

            if (ProcessedRequestIds.Contains(request.requestId))
            {
                TryDeleteRequestFile(request.requestId);
                continue;
            }

            // Skip already acknowledged (within this session)
            if (AcknowledgedRequestIds.Contains(request.requestId)) continue;

            // Skip stale requests (older than 5 minutes)
            if (request.requestedAtUnixMs > 0 && (now - request.requestedAtUnixMs) > StaleThresholdMs)
            {
                TryDeleteRequestFile(request.requestId);
                continue;
            }

            // Domain reload safety: check for existing status file
            string statusPath = Path.Combine(IpcDir, StatusFilePrefix + request.requestId + ".json");
            if (File.Exists(statusPath))
            {
                try
                {
                    string statusJson = File.ReadAllText(statusPath);
                    var statusObj = JsonUtility.FromJson<StatusPayload>(statusJson);
                    if (statusObj != null)
                    {
                        if (IsTerminalState(statusObj.state))
                        {
                            TryDeleteRequestFile(request.requestId);
                            continue;
                        }
                        if (statusObj.state == "queued")
                        {
                            // Re-enqueue after domain reload — refresh timestamp so TS resets its deadline
                            WriteStatus(request, "queued", false, false, "Request re-queued after domain reload");
                            AcknowledgedRequestIds.Add(request.requestId);
                            RequestQueue.Add(request);
                            continue;
                        }
                        // Was mid-processing when domain reload hit — re-enqueue so handler
                        // runs again (e.g., recompile finds nothing changed after reload).
                        WriteStatus(request, "queued", false, false, "Request re-queued after domain reload");
                        AcknowledgedRequestIds.Add(request.requestId);
                        RequestQueue.Add(request);
                        continue;
                    }
                }
                catch (Exception) { /* couldn't read status — treat as new */ }
            }

            if (request.protocolVersion != ProtocolVersion)
            {
                WriteStatus(request, "bridge_error", false, false, "Unsupported protocol version");
                TryDeleteRequestFile(request.requestId);
                continue;
            }

            WriteStatus(request, "queued", false, false, "Request queued for processing");
            AcknowledgedRequestIds.Add(request.requestId);
            RequestQueue.Add(request);
        }

        RequestQueue.Sort((a, b) => a.requestedAtUnixMs.CompareTo(b.requestedAtUnixMs));

        if (_busyRequestId == null && RequestQueue.Count > 0)
        {
            RequestPayload next = RequestQueue[0];
            RequestQueue.RemoveAt(0);
            DispatchRequest(next);
        }

        CleanupStaleFiles(now);
    }

    private static bool IsTerminalState(string state)
    {
        return state == "completed" || state == "failed" || state == "bridge_error"
            || state == "timeout" || state == "tests_finished" || state == "list_tests_finished";
    }

    private static void DispatchRequest(RequestPayload request)
    {
        if (request.action == "bootstrap_handshake")
        {
            WriteStatus(request, "completed", false, true, "Bridge loaded and handshake acknowledged");
            ProcessedRequestIds.Add(request.requestId);
            AcknowledgedRequestIds.Remove(request.requestId);
            TryDeleteRequestFile(request.requestId);
            QueueRequestCheck();
            return;
        }

        if (ActionHandlers.TryGetValue(request.action, out var handler))
        {
            // Handlers call MarkBusy internally via their registration pattern
            handler(request, NowUnixMs());
        }
        else
        {
            WriteStatus(request, "bridge_error", false, false, "Unsupported action: " + request.action);
            ProcessedRequestIds.Add(request.requestId);
            AcknowledgedRequestIds.Remove(request.requestId);
            TryDeleteRequestFile(request.requestId);
            QueueRequestCheck();
        }
    }

    private static void OnEditorUpdate()
    {
        if (_requestCheckQueued) ProcessRequestOnMainThread();
    }

    private static void EnsureLoopKickTimerRunning()
    {
        lock (Sync)
        {
            if (_loopKickTimer != null) return;
            _loopKickTimer = new Timer(_ => { TryKickEditorLoop(); }, null, 0, 500);
        }
    }

    // Called only from main thread (MarkFree → FinalizeRequest path)
    private static void UpdateLoopKickTimerState()
    {
        int queueCount = RequestQueue.Count; // safe: only mutated on main thread
        lock (Sync)
        {
            bool needsKicks = _requestCheckQueued || _busyRequestId != null || queueCount > 0;
            if (!needsKicks && _loopKickTimer != null)
            {
                try { _loopKickTimer.Dispose(); } catch (Exception) { }
                _loopKickTimer = null;
            }
            else if (needsKicks && _loopKickTimer == null)
            {
                _loopKickTimer = new Timer(_ => { TryKickEditorLoop(); }, null, 0, 500);
            }
        }
    }

    private static void TryKickEditorLoop()
    {
        try { EditorApplication.QueuePlayerLoopUpdate(); } catch (Exception) { }
    }

    private static List<RequestPayload> ScanRequestFiles()
    {
        var results = new List<RequestPayload>();
        try
        {
            string[] files = Directory.GetFiles(IpcDir, "request-*.json");
            foreach (string filePath in files)
            {
                try
                {
                    string json = File.ReadAllText(filePath);
                    if (string.IsNullOrWhiteSpace(json)) continue;
                    var request = JsonUtility.FromJson<RequestPayload>(json);
                    if (request != null && !string.IsNullOrEmpty(request.requestId))
                        results.Add(request);
                }
                catch (Exception) { /* skip unreadable files */ }
            }
        }
        catch (Exception) { /* directory access failed */ }
        return results;
    }

    private static void WriteReady()
    {
        try
        {
            Directory.CreateDirectory(IpcDir);
            var payload = new ReadyPayload
            {
                protocolVersion = ProtocolVersion,
                bridgeVersion = BridgeVersion,
                projectPath = ProjectPath,
                readyAtUnixMs = NowUnixMs(),
            };
            TryWriteJsonAtomic(ReadyPath, JsonUtility.ToJson(payload, true));
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase ready write failed: " + ex);
        }
    }

    private static void TryWriteJsonAtomic(string path, string json)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string tempPath = path + ".tmp";
            File.WriteAllText(tempPath, json ?? string.Empty);
            if (File.Exists(path)) File.Delete(path);
            File.Move(tempPath, path);
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeBridgeBase JSON write failed: " + ex);
        }
    }

    private static void TryDeleteRequestFile(string requestId)
    {
        try
        {
            string path = Path.Combine(IpcDir, RequestFilePrefix + requestId + ".json");
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception) { }
    }

    private static void CleanupStaleFiles(long nowMs)
    {
        try
        {
            string[] statusFiles = Directory.GetFiles(IpcDir, "status-*.json");
            foreach (string filePath in statusFiles)
            {
                try
                {
                    string json = File.ReadAllText(filePath);
                    var status = JsonUtility.FromJson<StatusPayload>(json);
                    if (status == null) continue;
                    if (!IsTerminalState(status.state)) continue;
                    if (status.updatedAtUnixMs > 0 && (nowMs - status.updatedAtUnixMs) > StaleThresholdMs)
                        File.Delete(filePath);
                }
                catch (Exception) { /* skip unreadable */ }
            }

            string[] requestFiles = Directory.GetFiles(IpcDir, "request-*.json");
            foreach (string filePath in requestFiles)
            {
                try
                {
                    string json = File.ReadAllText(filePath);
                    var request = JsonUtility.FromJson<RequestPayload>(json);
                    if (request == null) continue;
                    // Skip active or queued requests — they may legitimately be >5min old
                    if (request.requestId == _busyRequestId) continue;
                    if (AcknowledgedRequestIds.Contains(request.requestId)) continue;
                    if (request.requestedAtUnixMs > 0 && (nowMs - request.requestedAtUnixMs) > StaleThresholdMs)
                        File.Delete(filePath);
                }
                catch (Exception) { /* skip unreadable */ }
            }
        }
        catch (Exception) { /* directory access failed */ }
    }
}
