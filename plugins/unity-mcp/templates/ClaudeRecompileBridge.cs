// ClaudeRecompileBridge Version: 3
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

[InitializeOnLoad]
internal static class ClaudeRecompileBridge
{
    private const int ProtocolVersion = 1;
    private const string BridgeVersion = "3";
    private const string RequestFileName = "request.json";
    private const string ReadyFileName = "bridge-ready.json";
    private const double NoCompileStartTimeoutSeconds = 10.0;

    [Serializable]
    private class RequestPayload
    {
        public int protocolVersion;
        public string requestId;
        public long requestedAtUnixMs;
        public string projectPath;
        public string action;
        public string reason;
        public string source;
    }

    [Serializable]
    private class ErrorPayload
    {
        public string assembly;
        public string file;
        public int line;
        public int column;
        public string message;
        public string type;
    }

    [Serializable]
    private class StatusPayload
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
    }

    [Serializable]
    private class ReadyPayload
    {
        public int protocolVersion;
        public string bridgeVersion;
        public string projectPath;
        public long readyAtUnixMs;
    }

    private class ActiveRequest
    {
        public RequestPayload Request;
        public long CreatedAtUnixMs;
        public double RefreshRequestedAtEditorTime;
        public bool CompilationStarted;
        public bool Finalized;
        public readonly List<ErrorPayload> Errors = new List<ErrorPayload>();
    }

    private static readonly object Sync = new object();
    private static FileSystemWatcher _watcher;
    private static bool _requestCheckQueued;
    private static Timer _loopKickTimer;
    private static readonly HashSet<string> ProcessedRequestIds = new HashSet<string>();
    private static ActiveRequest _activeRequest;
    private static string ProjectPath => Directory.GetParent(Application.dataPath).FullName;
    private static string IpcDir => Path.Combine(ProjectPath, "Library", "ClaudeHookIPC");
    private static string RequestPath => Path.Combine(IpcDir, RequestFileName);
    private static string ReadyPath => Path.Combine(IpcDir, ReadyFileName);

    static ClaudeRecompileBridge()
    {
        try
        {
            Directory.CreateDirectory(IpcDir);
            CompilationPipeline.compilationStarted -= OnCompilationStarted;
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished -= OnCompilationFinished;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
            EditorApplication.update -= OnEditorUpdate;
            EditorApplication.update += OnEditorUpdate;

            StartWatcher();
            WriteReady();
            EnsureLoopKickTimerRunning();
            TryKickEditorLoop();
            ProcessRequestOnMainThread();
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeRecompileBridge init failed: " + ex);
        }
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
            Debug.LogError("ClaudeRecompileBridge watcher failed: " + ex);
        }
    }

    private static void OnRequestFileEvent(object sender, FileSystemEventArgs e)
    {
        QueueRequestCheck("watcher");
    }

    private static void OnRequestFileRenamed(object sender, RenamedEventArgs e)
    {
        QueueRequestCheck("watcher-renamed");
    }

    private static void QueueRequestCheck(string reason)
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
        lock (Sync)
        {
            _requestCheckQueued = false;
        }

        RequestPayload request = TryReadRequest();
        if (request == null)
            return;

        if (request.protocolVersion != ProtocolVersion)
        {
            TryWriteStatus(request, "bridge_error", false, false, "Unsupported protocol version", new List<ErrorPayload>());
            return;
        }

        if (!string.Equals(request.projectPath ?? string.Empty, ProjectPath, StringComparison.Ordinal))
            return;

        if (string.IsNullOrEmpty(request.requestId))
            return;

        if (ProcessedRequestIds.Contains(request.requestId))
            return;

        if (_activeRequest != null)
        {
            if (_activeRequest.Request != null && _activeRequest.Request.requestId == request.requestId)
                return;

            TryWriteStatus(request, "busy", false, false, "Bridge is busy with another request", new List<ErrorPayload>());
            return;
        }

        if (request.action == "bootstrap_handshake")
        {
            TryWriteStatus(request, "completed", false, true, "Bridge loaded and handshake acknowledged", new List<ErrorPayload>());
            ProcessedRequestIds.Add(request.requestId);
            TryDeleteRequestFileIfMatches(request.requestId);
            return;
        }

        if (request.action != "recompile")
        {
            TryWriteStatus(request, "bridge_error", false, false, "Unsupported action: " + request.action, new List<ErrorPayload>());
            ProcessedRequestIds.Add(request.requestId);
            TryDeleteRequestFileIfMatches(request.requestId);
            return;
        }

        _activeRequest = new ActiveRequest
        {
            Request = request,
            CreatedAtUnixMs = NowUnixMs(),
            RefreshRequestedAtEditorTime = EditorApplication.timeSinceStartup,
            CompilationStarted = false,
            Finalized = false,
        };
        EnsureLoopKickTimerRunning();

        TryWriteStatus(request, "queued", false, true, "Request accepted", _activeRequest.Errors);
        TryWriteStatus(request, "refresh_requested", false, true, "AssetDatabase.Refresh requested", _activeRequest.Errors);

        try
        {
            AssetDatabase.Refresh();
        }
        catch (Exception ex)
        {
            FinalizeActiveRequest(false, false, "AssetDatabase.Refresh failed: " + ex.Message);
        }
    }

    private static void OnEditorUpdate()
    {
        if (_requestCheckQueued)
        {
            ProcessRequestOnMainThread();
        }

        if (_activeRequest == null || _activeRequest.Request == null)
            return;
        if (_activeRequest.Finalized)
            return;
        if (_activeRequest.CompilationStarted)
            return;
        if (_activeRequest.Request.action != "recompile")
            return;

        if ((EditorApplication.timeSinceStartup - _activeRequest.RefreshRequestedAtEditorTime) < NoCompileStartTimeoutSeconds)
            return;

        if (EditorApplication.isCompiling || EditorApplication.isUpdating)
        {
            return;
        }

        FinalizeActiveRequest(false, true, "No compilation started after refresh");
    }

    private static void OnCompilationStarted(object context)
    {
        if (_activeRequest == null || _activeRequest.Request == null || _activeRequest.Finalized)
            return;

        _activeRequest.CompilationStarted = true;
        TryWriteStatus(_activeRequest.Request, "compilation_started", true, true, "Compilation started", _activeRequest.Errors);
    }

    private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
    {
        if (_activeRequest == null || _activeRequest.Request == null || _activeRequest.Finalized)
            return;

        if (messages == null)
            return;

        for (int i = 0; i < messages.Length; i++)
        {
            CompilerMessage msg = messages[i];
            if (msg.type != CompilerMessageType.Error)
                continue;

            var error = new ErrorPayload
            {
                assembly = Path.GetFileNameWithoutExtension(assemblyPath ?? string.Empty),
                file = msg.file ?? string.Empty,
                line = msg.line,
                column = msg.column,
                message = msg.message ?? string.Empty,
                type = "Error",
            };
            _activeRequest.Errors.Add(error);
        }
    }

    private static void OnCompilationFinished(object context)
    {
        if (_activeRequest == null || _activeRequest.Request == null || _activeRequest.Finalized)
            return;

        if (!_activeRequest.CompilationStarted)
            _activeRequest.CompilationStarted = true;

        TryWriteStatus(_activeRequest.Request, "compilation_finished", true, _activeRequest.Errors.Count == 0, "Compilation finished", _activeRequest.Errors);
        FinalizeActiveRequest(true, _activeRequest.Errors.Count == 0, _activeRequest.Errors.Count == 0 ? "Compilation succeeded" : "Compilation failed", true);
    }

    private static void FinalizeActiveRequest(bool didCompile, bool isSuccess, string summary, bool fromCompilationFinished = false)
    {
        if (_activeRequest == null || _activeRequest.Request == null)
            return;
        if (_activeRequest.Finalized)
            return;

        _activeRequest.Finalized = true;
        string finalState = isSuccess ? "completed" : "failed";
        if (!fromCompilationFinished && !didCompile)
            finalState = "completed";

        TryWriteStatus(_activeRequest.Request, finalState, didCompile, isSuccess, summary, _activeRequest.Errors);
        ProcessedRequestIds.Add(_activeRequest.Request.requestId);
        TryDeleteRequestFileIfMatches(_activeRequest.Request.requestId);
        _activeRequest = null;
        UpdateLoopKickTimerState();
        WriteReady();
    }

    private static void EnsureLoopKickTimerRunning()
    {
        lock (Sync)
        {
            if (_loopKickTimer != null)
                return;

            _loopKickTimer = new Timer(_ =>
            {
                TryKickEditorLoop();
            }, null, 0, 500);
        }
    }

    private static void UpdateLoopKickTimerState()
    {
        lock (Sync)
        {
            bool needsKicks = _requestCheckQueued || _activeRequest != null;
            if (!needsKicks && _loopKickTimer != null)
            {
                try
                {
                    _loopKickTimer.Dispose();
                }
                catch (Exception)
                {
                }
                _loopKickTimer = null;
            }
            else if (needsKicks && _loopKickTimer == null)
            {
                _loopKickTimer = new Timer(_ =>
                {
                    TryKickEditorLoop();
                }, null, 0, 500);
            }
        }
    }

    private static void TryKickEditorLoop()
    {
        try
        {
            EditorApplication.QueuePlayerLoopUpdate();
        }
        catch (Exception)
        {
        }
    }

    private static RequestPayload TryReadRequest()
    {
        try
        {
            if (!File.Exists(RequestPath))
                return null;

            string json = File.ReadAllText(RequestPath);
            if (string.IsNullOrWhiteSpace(json))
                return null;

            return JsonUtility.FromJson<RequestPayload>(json);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void TryWriteStatus(RequestPayload request, string state, bool didCompile, bool isSuccess, string summary, List<ErrorPayload> errors)
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
            createdAtUnixMs = _activeRequest != null ? _activeRequest.CreatedAtUnixMs : NowUnixMs(),
            updatedAtUnixMs = NowUnixMs(),
            didCompile = didCompile,
            isSuccess = isSuccess,
            errors = errors != null ? new List<ErrorPayload>(errors) : new List<ErrorPayload>(),
            summary = summary ?? string.Empty,
        };

        string path = Path.Combine(IpcDir, "status-" + request.requestId + ".json");
        TryWriteJsonAtomic(path, JsonUtility.ToJson(payload, true));
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
            Debug.LogError("ClaudeRecompileBridge ready write failed: " + ex);
        }
    }

    private static void TryWriteJsonAtomic(string path, string json)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string tempPath = path + ".tmp";
            File.WriteAllText(tempPath, json ?? string.Empty);
            if (File.Exists(path))
                File.Delete(path);
            File.Move(tempPath, path);
        }
        catch (Exception ex)
        {
            Debug.LogError("ClaudeRecompileBridge JSON write failed: " + ex);
        }
    }

    private static void TryDeleteRequestFileIfMatches(string requestId)
    {
        try
        {
            if (!File.Exists(RequestPath))
                return;

            RequestPayload current = TryReadRequest();
            if (current != null && current.requestId == requestId)
                File.Delete(RequestPath);
        }
        catch (Exception)
        {
        }
    }

    private static long NowUnixMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
