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
    private const string RequestFileName = "request.json";
    private const string ReadyFileName = "bridge-ready.json";

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

    internal static string ProjectPath => Directory.GetParent(Application.dataPath).FullName;
    internal static string IpcDir => Path.Combine(ProjectPath, "Library", "ClaudeHookIPC");
    private static string RequestPath => Path.Combine(IpcDir, RequestFileName);
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

        string path = Path.Combine(IpcDir, "status-" + request.requestId + ".json");
        TryWriteJsonAtomic(path, JsonUtility.ToJson(payload, true));
    }

    internal static void FinalizeRequest(RequestPayload request)
    {
        if (request == null) return;
        ProcessedRequestIds.Add(request.requestId);
        TryDeleteRequestFileIfMatches(request.requestId);
        MarkFree();
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

            _watcher = new FileSystemWatcher(IpcDir, RequestFileName)
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

        RequestPayload request = TryReadRequest();
        if (request == null) return;

        if (request.protocolVersion != ProtocolVersion)
        {
            WriteStatus(request, "bridge_error", false, false, "Unsupported protocol version");
            return;
        }

        if (!string.Equals(request.projectPath ?? string.Empty, ProjectPath, StringComparison.Ordinal)) return;
        if (string.IsNullOrEmpty(request.requestId)) return;
        if (ProcessedRequestIds.Contains(request.requestId)) return;

        if (_busyRequestId != null)
        {
            if (_busyRequestId == request.requestId) return;
            WriteStatus(request, "busy", false, false, "Bridge is busy with another request");
            return;
        }

        if (request.action == "bootstrap_handshake")
        {
            WriteStatus(request, "completed", false, true, "Bridge loaded and handshake acknowledged");
            ProcessedRequestIds.Add(request.requestId);
            TryDeleteRequestFileIfMatches(request.requestId);
            return;
        }

        if (ActionHandlers.TryGetValue(request.action, out var handler))
        {
            handler(request, NowUnixMs());
        }
        else
        {
            WriteStatus(request, "bridge_error", false, false, "Unsupported action: " + request.action);
            ProcessedRequestIds.Add(request.requestId);
            TryDeleteRequestFileIfMatches(request.requestId);
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

    private static void UpdateLoopKickTimerState()
    {
        lock (Sync)
        {
            bool needsKicks = _requestCheckQueued || _busyRequestId != null;
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

    private static RequestPayload TryReadRequest()
    {
        try
        {
            if (!File.Exists(RequestPath)) return null;
            string json = File.ReadAllText(RequestPath);
            if (string.IsNullOrWhiteSpace(json)) return null;
            return JsonUtility.FromJson<RequestPayload>(json);
        }
        catch (Exception) { return null; }
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

    private static void TryDeleteRequestFileIfMatches(string requestId)
    {
        try
        {
            if (!File.Exists(RequestPath)) return;
            RequestPayload current = TryReadRequest();
            if (current != null && current.requestId == requestId) File.Delete(RequestPath);
        }
        catch (Exception) { }
    }
}
