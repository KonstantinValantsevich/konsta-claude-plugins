// ClaudeRecompileHandler Version: 5
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

internal static class ClaudeRecompileHandler
{
    private const double NoCompileStartTimeoutSeconds = 10.0;

    private class ActiveRecompile
    {
        public ClaudeBridgeBase.RequestPayload Request;
        public long CreatedAtUnixMs;
        public double RefreshRequestedAtEditorTime;
        public bool CompilationStarted;
        public bool Finalized;
        public readonly List<ClaudeBridgeBase.ErrorPayload> Errors = new List<ClaudeBridgeBase.ErrorPayload>();
        public readonly List<string> LogErrors = new List<string>();
    }

    private static ActiveRecompile _active;

    internal static void Register()
    {
        CompilationPipeline.compilationStarted -= OnCompilationStarted;
        CompilationPipeline.compilationStarted += OnCompilationStarted;
        CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
        CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
        CompilationPipeline.compilationFinished -= OnCompilationFinished;
        CompilationPipeline.compilationFinished += OnCompilationFinished;
        EditorApplication.update -= OnEditorUpdate;
        EditorApplication.update += OnEditorUpdate;

        ClaudeBridgeBase.RegisterAction("recompile", HandleRecompile);
    }

    private static void HandleRecompile(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        _active = new ActiveRecompile
        {
            Request = request,
            CreatedAtUnixMs = createdAtUnixMs,
            RefreshRequestedAtEditorTime = EditorApplication.timeSinceStartup,
            CompilationStarted = false,
            Finalized = false,
        };

        ClaudeBridgeBase.MarkBusy(request.requestId);
        ClaudeBridgeBase.WriteStatus(request, "queued", false, true, "Request accepted", _active.Errors);
        ClaudeBridgeBase.WriteStatus(request, "refresh_requested", false, true, "AssetDatabase.Refresh requested", _active.Errors);

        Application.logMessageReceived -= OnLogMessageReceived;
        Application.logMessageReceived += OnLogMessageReceived;

        try { AssetDatabase.Refresh(); }
        catch (Exception ex) { Finalize(false, false, "AssetDatabase.Refresh failed: " + ex.Message); }
    }

    private static void OnEditorUpdate()
    {
        if (_active == null || _active.Finalized) return;
        if (_active.CompilationStarted) return;

        if ((EditorApplication.timeSinceStartup - _active.RefreshRequestedAtEditorTime) < NoCompileStartTimeoutSeconds) return;
        if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

        PromoteLogErrors();
        bool hasErrors = _active.Errors.Count > 0;
        Finalize(false, !hasErrors, hasErrors ? "Compilation blocked by errors" : "No compilation started after refresh");
    }

    private static void OnLogMessageReceived(string condition, string stackTrace, LogType type)
    {
        if (_active == null || _active.Finalized) return;
        if (type != LogType.Error && type != LogType.Exception) return;
        // Ignore our own bridge logs
        if (condition != null && condition.StartsWith("[ClaudeBridge]")) return;
        _active.LogErrors.Add(condition ?? string.Empty);
    }

    private static void OnCompilationStarted(object context)
    {
        if (_active == null || _active.Finalized) return;
        _active.CompilationStarted = true;
        ClaudeBridgeBase.WriteStatus(_active.Request, "compilation_started", true, true, "Compilation started", _active.Errors);
    }

    private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
    {
        string asm = System.IO.Path.GetFileNameWithoutExtension(assemblyPath ?? string.Empty);
        int totalMessages = messages?.Length ?? 0;
        Debug.Log($"[ClaudeBridge] assemblyCompilationFinished: assembly={asm} messages={totalMessages} activeNull={_active == null} finalized={_active?.Finalized}");

        if (_active == null || _active.Finalized) return;
        if (messages == null) return;

        int errorsBefore = _active.Errors.Count;
        for (int i = 0; i < messages.Length; i++)
        {
            CompilerMessage msg = messages[i];
            if (msg.type != CompilerMessageType.Error) continue;

            _active.Errors.Add(new ClaudeBridgeBase.ErrorPayload
            {
                assembly = asm,
                file = msg.file ?? string.Empty,
                line = msg.line,
                column = msg.column,
                message = msg.message ?? string.Empty,
                type = "Error",
            });
        }
        Debug.Log($"[ClaudeBridge] assemblyCompilationFinished: errorsAdded={_active.Errors.Count - errorsBefore} totalErrors={_active.Errors.Count}");
    }

    private static void OnCompilationFinished(object context)
    {
        Debug.Log($"[ClaudeBridge] compilationFinished: activeNull={_active == null} finalized={_active?.Finalized} errorCount={_active?.Errors?.Count}");

        if (_active == null || _active.Finalized) return;
        if (!_active.CompilationStarted) _active.CompilationStarted = true;

        PromoteLogErrors();
        bool success = _active.Errors.Count == 0;
        ClaudeBridgeBase.WriteStatus(_active.Request, "compilation_finished", true, success, "Compilation finished", _active.Errors);
        Finalize(true, success, success ? "Compilation succeeded" : "Compilation failed");
    }

    private static void PromoteLogErrors()
    {
        if (_active == null) return;
        // Only promote log errors if no compiler errors were captured (avoids duplicates)
        if (_active.Errors.Count > 0 || _active.LogErrors.Count == 0) return;
        for (int i = 0; i < _active.LogErrors.Count; i++)
        {
            _active.Errors.Add(new ClaudeBridgeBase.ErrorPayload
            {
                assembly = string.Empty,
                file = string.Empty,
                line = 0,
                column = 0,
                message = _active.LogErrors[i],
                type = "Error",
            });
        }
    }

    private static void Finalize(bool didCompile, bool isSuccess, string summary)
    {
        if (_active == null || _active.Finalized) return;
        Application.logMessageReceived -= OnLogMessageReceived;
        _active.Finalized = true;
        string finalState = isSuccess ? "completed" : "failed";
        if (!didCompile && isSuccess) finalState = "completed";

        Debug.Log($"[ClaudeBridge] Finalize: state={finalState} didCompile={didCompile} isSuccess={isSuccess} errorCount={_active.Errors.Count} summary={summary}");
        for (int i = 0; i < _active.Errors.Count; i++)
        {
            var e = _active.Errors[i];
            Debug.Log($"[ClaudeBridge] Error[{i}]: {e.file}({e.line},{e.column}): {e.message}");
        }

        ClaudeBridgeBase.WriteStatus(_active.Request, finalState, didCompile, isSuccess, summary, _active.Errors);
        ClaudeBridgeBase.FinalizeRequest(_active.Request);
        _active = null;
    }
}
