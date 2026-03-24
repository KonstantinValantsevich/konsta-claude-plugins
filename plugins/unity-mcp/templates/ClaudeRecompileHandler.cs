// ClaudeRecompileHandler Version: 4
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

        try { AssetDatabase.Refresh(); }
        catch (Exception ex) { Finalize(false, false, "AssetDatabase.Refresh failed: " + ex.Message); }
    }

    private static void OnEditorUpdate()
    {
        if (_active == null || _active.Finalized) return;
        if (_active.CompilationStarted) return;

        if ((EditorApplication.timeSinceStartup - _active.RefreshRequestedAtEditorTime) < NoCompileStartTimeoutSeconds) return;
        if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

        Finalize(false, true, "No compilation started after refresh");
    }

    private static void OnCompilationStarted(object context)
    {
        if (_active == null || _active.Finalized) return;
        _active.CompilationStarted = true;
        ClaudeBridgeBase.WriteStatus(_active.Request, "compilation_started", true, true, "Compilation started", _active.Errors);
    }

    private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
    {
        if (_active == null || _active.Finalized) return;
        if (messages == null) return;

        for (int i = 0; i < messages.Length; i++)
        {
            CompilerMessage msg = messages[i];
            if (msg.type != CompilerMessageType.Error) continue;

            _active.Errors.Add(new ClaudeBridgeBase.ErrorPayload
            {
                assembly = System.IO.Path.GetFileNameWithoutExtension(assemblyPath ?? string.Empty),
                file = msg.file ?? string.Empty,
                line = msg.line,
                column = msg.column,
                message = msg.message ?? string.Empty,
                type = "Error",
            });
        }
    }

    private static void OnCompilationFinished(object context)
    {
        if (_active == null || _active.Finalized) return;
        if (!_active.CompilationStarted) _active.CompilationStarted = true;

        ClaudeBridgeBase.WriteStatus(_active.Request, "compilation_finished", true, _active.Errors.Count == 0, "Compilation finished", _active.Errors);
        Finalize(true, _active.Errors.Count == 0, _active.Errors.Count == 0 ? "Compilation succeeded" : "Compilation failed");
    }

    private static void Finalize(bool didCompile, bool isSuccess, string summary)
    {
        if (_active == null || _active.Finalized) return;
        _active.Finalized = true;
        string finalState = isSuccess ? "completed" : "failed";
        if (!didCompile && isSuccess) finalState = "completed";

        ClaudeBridgeBase.WriteStatus(_active.Request, finalState, didCompile, isSuccess, summary, _active.Errors);
        ClaudeBridgeBase.FinalizeRequest(_active.Request);
        _active = null;
    }
}
