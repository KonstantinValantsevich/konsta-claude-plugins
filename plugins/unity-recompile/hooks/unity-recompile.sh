#!/bin/bash
# Unity Recompile Hook for Claude Code
# Triggers Unity recompilation after .cs files are edited and reports errors

set -euo pipefail

# Debug log file
CACHE_DIR=~/.claude/cache/unity-recompile
mkdir -p "$CACHE_DIR"
DEBUG_LOG="$CACHE_DIR/unity-recompile.log"

log() {
    echo "[$(date '+%H:%M:%S')] $*" >> "$DEBUG_LOG"
}

log "=== Hook started ==="

# Configuration
LOG_FILE=~/Library/Logs/Unity/Editor.log
POLL_INTERVAL=0.5
NO_ACTIVITY_TIMEOUT=10  # Legacy heuristic path only
MARKER_DIR="$CACHE_DIR/markers"
mkdir -p "$MARKER_DIR"

# Bridge configuration
BRIDGE_PROTOCOL_VERSION=1
BRIDGE_VERSION="3"
BRIDGE_READY_TIMEOUT_SECS=120
BRIDGE_STATUS_TIMEOUT_SECS=120
BRIDGE_BUSY_RETRY_DELAY_SECS=1
BRIDGE_MAX_BUSY_RETRIES=1

# Read stdin JSON containing session info
stdin_json=$(cat)
log "stdin length: ${#stdin_json}"

# Extract cwd from Stop hook data
cwd=$(echo "$stdin_json" | jq -r '.cwd // empty')
log "cwd: $cwd"

if [[ -z "$cwd" ]]; then
    log "ERROR: No cwd in stdin JSON"
    exit 0
fi

# Walk up from cwd to find Unity project root
project_path=""
dir="$cwd"
while [[ "$dir" != "/" && "$dir" != "." ]]; do
    if [[ -d "$dir/Assets" && -f "$dir/ProjectSettings/ProjectVersion.txt" ]]; then
        project_path="$dir"
        break
    fi
    dir=$(dirname "$dir")
done

if [[ -z "$project_path" ]]; then
    log "Not a Unity project: $cwd"
    exit 0
fi
log "Unity project: $project_path"

# Skip if project has its own recompile hook (e.g. MCP-based)
if [[ -f "$project_path/.claude/hooks-skip-recompile" ]]; then
    log "Skipping: project has .claude/hooks-skip-recompile marker"
    exit 0
fi

# Marker file for this project (hash the path for safe filename)
project_hash=$(echo -n "$project_path" | md5 -q)
marker_file="$MARKER_DIR/recompile-$project_hash"

# Create marker if it doesn't exist (first run — check everything)
if [[ ! -f "$marker_file" ]]; then
    touch -t 197001010000 "$marker_file"  # epoch — will match all .cs files
fi

# Check if any .cs files are newer than the marker
cs_changed=$(find "$project_path/Assets" -name "*.cs" -newer "$marker_file" -print -quit 2>/dev/null || true)
log "cs_changed: $cs_changed"

if [[ -z "$cs_changed" ]]; then
    log "No .cs files changed since last check, exiting"
    exit 0
fi

log "C# files changed, triggering recompilation"

# Bridge paths
BRIDGE_ROOT_DIR="$project_path/Assets/Recompile Hook"
BRIDGE_EDITOR_DIR="$BRIDGE_ROOT_DIR/Editor"
BRIDGE_FILE="$BRIDGE_EDITOR_DIR/ClaudeRecompileBridge.cs"
BRIDGE_IPC_DIR="$project_path/Library/ClaudeHookIPC"
BRIDGE_REQUEST_FILE="$BRIDGE_IPC_DIR/request.json"
BRIDGE_READY_FILE="$BRIDGE_IPC_DIR/bridge-ready.json"

bridge_changed_this_run=0
bridge_result_state=""
bridge_result_status_file=""
bridge_result_errors=""
bridge_result_success=1
legacy_errors=""
attempted_recompile=0

# Function to find Unity PID for our project
find_unity_pid_for_project() {
    ps aux | grep "[U]nity" | grep "$project_path" | grep -v batchMode | awk '{print $2}' | head -1
}

# Function to check if Unity is running for our project
unity_is_running() {
    local pid
    pid=$(find_unity_pid_for_project)
    [[ -n "$pid" ]]
}

# Function to trigger refresh via AppleScript
trigger_refresh_applescript() {
    local unity_pid
    unity_pid=$(find_unity_pid_for_project)

    if [[ -z "$unity_pid" ]]; then
        echo "Error: Could not find Unity process for project" >&2
        return 1
    fi

    osascript -e "
        set previousApp to (path to frontmost application as text)

        tell application \"System Events\"
            set frontmost of (first process whose unix id is $unity_pid) to true
        end tell

        delay 0.3

        tell application \"System Events\"
            keystroke \"r\" using command down
        end tell

        return previousApp
    "
}

# Function to switch back to previous app
switch_back_to_app() {
    local app_name="$1"
    osascript -e "tell application \"$app_name\" to activate" 2>/dev/null || true
}

# Legacy heuristic functions retained for non-editor CLI fallback / emergency use
get_max_dll_mtime() {
    local assemblies_dir="$project_path/Library/ScriptAssemblies"
    if [[ -d "$assemblies_dir" ]]; then
        stat -f "%m" "$assemblies_dir"/*.dll 2>/dev/null | sort -rn | head -1
    else
        echo "0"
    fi
}

wait_for_compile() {
    local start_log_pos=$1
    local baseline_mtime
    baseline_mtime=$(get_max_dll_mtime)
    local no_activity_count=0
    local last_log_size=$start_log_pos

    log "[legacy] Baseline DLL mtime: $baseline_mtime"

    while true; do
        sleep $POLL_INTERVAL

        local current_mtime
        current_mtime=$(get_max_dll_mtime)
        if [[ "$current_mtime" -gt "$baseline_mtime" ]]; then
            log "[legacy] DLL mtime changed: $baseline_mtime -> $current_mtime"
            sleep 0.3
            return 0
        fi

        if [[ -f "$LOG_FILE" ]]; then
            local current_log_size
            current_log_size=$(wc -c < "$LOG_FILE")

            if [[ $current_log_size -gt $start_log_pos ]]; then
                if tail -c +$((start_log_pos + 1)) "$LOG_FILE" | grep -q "error CS"; then
                    log "[legacy] Compilation errors detected in log"
                    return 0
                fi
            fi

            if [[ $current_log_size -gt $last_log_size ]]; then
                no_activity_count=0
                last_log_size=$current_log_size
            else
                ((no_activity_count++))
            fi

            if [[ $no_activity_count -ge $NO_ACTIVITY_TIMEOUT ]]; then
                log "[legacy] No log activity for ${NO_ACTIVITY_TIMEOUT} polls, assuming no compilation needed"
                return 0
            fi
        else
            ((no_activity_count++))
            if [[ $no_activity_count -ge $NO_ACTIVITY_TIMEOUT ]]; then
                log "[legacy] No Editor.log found, assuming no compilation needed"
                return 0
            fi
        fi
    done
}

extract_errors_from_log() {
    local start_pos=$1
    if [[ -f "$LOG_FILE" ]]; then
        tail -c +$((start_pos + 1)) "$LOG_FILE" | grep "error CS" || true
    fi
}

run_cli_fallback() {
    local version_file="$project_path/ProjectSettings/ProjectVersion.txt"
    if [[ ! -f "$version_file" ]]; then
        echo "Error: Could not find ProjectVersion.txt" >&2
        return 1
    fi

    local unity_version
    unity_version=$(grep "m_EditorVersion:" "$version_file" | cut -d' ' -f2)
    if [[ -z "$unity_version" ]]; then
        echo "Error: Could not detect Unity version" >&2
        return 1
    fi

    local unity_path="/Applications/Unity/Hub/Editor/${unity_version}/Unity.app/Contents/MacOS/Unity"
    if [[ ! -x "$unity_path" ]]; then
        echo "Error: Unity not found at: $unity_path" >&2
        echo "Please ensure Unity ${unity_version} is installed via Unity Hub" >&2
        return 1
    fi

    echo "Unity not running. Starting batch compilation (this may take a moment)..." >&2

    "$unity_path" \
        -batchmode \
        -projectPath "$project_path" \
        -executeMethod UnityEditor.AssetDatabase.Refresh \
        -logFile - \
        -quit \
        2>&1 | grep "error CS" || true
}

# Bridge helpers
bridge_generate_request_id() {
    local rnd
    rnd=$(od -An -N4 -tx4 /dev/urandom 2>/dev/null | tr -d ' \n')
    echo "$(date +%s)-$$-${rnd:-0}"
}

bridge_status_file_for_request() {
    local request_id="$1"
    echo "$BRIDGE_IPC_DIR/status-${request_id}.json"
}

ensure_local_git_exclude_for_bridge() {
    local git_dir
    git_dir=$(git -C "$project_path" rev-parse --git-dir 2>/dev/null || true)
    if [[ -z "$git_dir" ]]; then
        log "Bridge exclude: unable to locate .git dir, skipping"
        return 0
    fi

    local exclude_file="$project_path/$git_dir/info/exclude"
    mkdir -p "$(dirname "$exclude_file")"
    touch "$exclude_file"

    local pattern1="/Assets/Recompile Hook/"
    local pattern2="/Assets/Recompile Hook.meta"

    if ! grep -Fqx "$pattern1" "$exclude_file"; then
        echo "$pattern1" >> "$exclude_file"
        log "Bridge exclude: added $pattern1"
    fi
    if ! grep -Fqx "$pattern2" "$exclude_file"; then
        echo "$pattern2" >> "$exclude_file"
        log "Bridge exclude: added $pattern2"
    fi
}

bridge_source_template() {
    cat <<'CS_EOF'
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
CS_EOF
}

ensure_bridge_installed() {
    mkdir -p "$BRIDGE_EDITOR_DIR"
    local tmp_file
    tmp_file=$(mktemp "$BRIDGE_IPC_DIR/bridge-src.XXXXXX" 2>/dev/null || mktemp /tmp/bridge-src.XXXXXX)
    bridge_source_template > "$tmp_file"

    if [[ ! -f "$BRIDGE_FILE" ]] || ! cmp -s "$tmp_file" "$BRIDGE_FILE"; then
        mkdir -p "$BRIDGE_EDITOR_DIR"
        mv "$tmp_file" "$BRIDGE_FILE"
        bridge_changed_this_run=1
        log "Bridge installed/updated: $BRIDGE_FILE"
    else
        rm -f "$tmp_file"
        log "Bridge already up to date"
    fi
}

bridge_ready_matches_project() {
    [[ -f "$BRIDGE_READY_FILE" ]] || return 1

    local ready_project ready_version ready_protocol
    ready_project=$(jq -r '.projectPath // ""' "$BRIDGE_READY_FILE" 2>/dev/null || echo "")
    ready_version=$(jq -r '.bridgeVersion // ""' "$BRIDGE_READY_FILE" 2>/dev/null || echo "")
    ready_protocol=$(jq -r '.protocolVersion // 0' "$BRIDGE_READY_FILE" 2>/dev/null || echo 0)

    [[ "$ready_project" == "$project_path" ]] || return 1
    [[ "$ready_version" == "$BRIDGE_VERSION" ]] || return 1
    [[ "$ready_protocol" == "$BRIDGE_PROTOCOL_VERSION" ]] || return 1
    return 0
}

wait_for_bridge_ready() {
    local timeout_secs="$1"
    local max_polls=$(( timeout_secs * 2 ))
    local i=0

    while [[ $i -lt $max_polls ]]; do
        if bridge_ready_matches_project; then
            log "Bridge ready file detected for project"
            return 0
        fi
        sleep "$POLL_INTERVAL"
        ((i++))
    done

    log "Timed out waiting for bridge-ready.json"
    return 1
}

write_bridge_request() {
    local action="$1"
    local request_id="$2"
    mkdir -p "$BRIDGE_IPC_DIR"

    local tmp_file="$BRIDGE_IPC_DIR/request.json.tmp"
    jq -n \
        --argjson protocolVersion "$BRIDGE_PROTOCOL_VERSION" \
        --arg requestId "$request_id" \
        --argjson requestedAtUnixMs "$(($(date +%s) * 1000))" \
        --arg projectPath "$project_path" \
        --arg action "$action" \
        --arg reason "claude-stop-hook" \
        --arg source "unity-recompile.sh" \
        '{protocolVersion:$protocolVersion,requestId:$requestId,requestedAtUnixMs:$requestedAtUnixMs,projectPath:$projectPath,action:$action,reason:$reason,source:$source}' \
        > "$tmp_file"
    mv "$tmp_file" "$BRIDGE_REQUEST_FILE"
    # FileSystemWatcher rename delivery can be unreliable on some setups; force a Changed event as well.
    touch "$BRIDGE_REQUEST_FILE"
    log "Wrote bridge request: action=$action requestId=$request_id"
}

wait_for_bridge_status() {
    local request_id="$1"
    local timeout_secs="$2"
    local status_file
    status_file=$(bridge_status_file_for_request "$request_id")
    local max_polls=$(( timeout_secs * 2 ))
    local i=0

    bridge_result_status_file="$status_file"
    bridge_result_state=""

    while [[ $i -lt $max_polls ]]; do
        if [[ -f "$status_file" ]]; then
            local seen_request_id state seen_version seen_protocol
            seen_request_id=$(jq -r '.requestId // ""' "$status_file" 2>/dev/null || echo "")
            if [[ "$seen_request_id" == "$request_id" ]]; then
                seen_version=$(jq -r '.bridgeVersion // ""' "$status_file" 2>/dev/null || echo "")
                seen_protocol=$(jq -r '.protocolVersion // 0' "$status_file" 2>/dev/null || echo 0)
                if [[ "$seen_version" != "$BRIDGE_VERSION" || "$seen_protocol" != "$BRIDGE_PROTOCOL_VERSION" ]]; then
                    sleep "$POLL_INTERVAL"
                    ((i++))
                    continue
                fi
                state=$(jq -r '.state // ""' "$status_file" 2>/dev/null || echo "")
                case "$state" in
                    completed|failed|bridge_error|busy|timeout)
                        bridge_result_state="$state"
                        log "Bridge status final: requestId=$request_id state=$state"
                        return 0
                        ;;
                    *)
                        ;;
                esac
            fi
        fi
        sleep "$POLL_INTERVAL"
        ((i++))
    done

    log "Timed out waiting for bridge status: requestId=$request_id"
    return 1
}

bridge_status_to_result() {
    local status_file="$1"
    [[ -f "$status_file" ]] || return 1

    bridge_result_errors=$(jq -r '
        (.errors // [])[]? as $e |
        if ((($e.message // "") | startswith(($e.file // "") + "("))) then
            ($e.message // "")
        elif (($e.file // "") != "") then
            ($e.file // "") + "(" + (($e.line // 0) | tostring) + "," + (($e.column // 0) | tostring) + "): " + ($e.message // "")
        else
            ($e.message // "")
        end
    ' "$status_file" 2>/dev/null || true)

    local is_success
    is_success=$(jq -r '.isSuccess // false' "$status_file" 2>/dev/null || echo false)
    local state
    state=$(jq -r '.state // ""' "$status_file" 2>/dev/null || echo "")
    local version
    version=$(jq -r '.bridgeVersion // ""' "$status_file" 2>/dev/null || echo "")
    local proto
    proto=$(jq -r '.protocolVersion // 0' "$status_file" 2>/dev/null || echo 0)
    local summary
    summary=$(jq -r '.summary // ""' "$status_file" 2>/dev/null || echo "")

    if [[ "$version" != "$BRIDGE_VERSION" || "$proto" != "$BRIDGE_PROTOCOL_VERSION" ]]; then
        bridge_result_success=0
        bridge_result_errors="Bridge status version mismatch (got version=$version protocol=$proto)"
        return 1
    fi

    if [[ "$state" == "busy" ]]; then
        bridge_result_success=0
        bridge_result_errors=${summary:-Bridge is busy}
        return 1
    fi
    if [[ "$state" == "bridge_error" || "$state" == "timeout" ]]; then
        bridge_result_success=0
        bridge_result_errors=${summary:-Bridge error}
        return 1
    fi

    if [[ "$is_success" == "true" ]]; then
        bridge_result_success=1
        return 0
    fi

    bridge_result_success=0
    if [[ -z "$bridge_result_errors" ]]; then
        bridge_result_errors=${summary:-Unity compilation failed}
    fi
    return 1
}

bridge_request_and_wait() {
    local action="$1"
    local timeout_secs="$2"
    local attempt=0

    while true; do
        local request_id
        request_id=$(bridge_generate_request_id)
        local status_file
        status_file=$(bridge_status_file_for_request "$request_id")
        rm -f "$status_file"

        write_bridge_request "$action" "$request_id"
        if ! wait_for_bridge_status "$request_id" "$timeout_secs"; then
            bridge_result_success=0
            bridge_result_errors="Timed out waiting for bridge status ($action)"
            return 1
        fi

        if bridge_status_to_result "$status_file"; then
            return 0
        fi

        if [[ "$bridge_result_state" == "busy" && $attempt -lt $BRIDGE_MAX_BUSY_RETRIES ]]; then
            ((attempt++))
            log "Bridge busy, retrying action=$action attempt=$attempt"
            sleep "$BRIDGE_BUSY_RETRY_DELAY_SECS"
            continue
        fi

        return 1
    done
}

trigger_editor_refresh_only() {
    local previous_app=""
    previous_app=$(trigger_refresh_applescript 2>/dev/null || echo "")
    if [[ -n "$previous_app" ]]; then
        switch_back_to_app "$previous_app"
    fi
    log "Triggered editor refresh (trigger-only path)"
    return 0
}

run_bridge_bootstrap_and_recompile() {
    log "Bridge bootstrap flow starting"

    if ! unity_is_running; then
        log "Bridge bootstrap unavailable: Unity editor not running"
        bridge_result_success=0
        bridge_result_errors="Unity Editor is not running, cannot bootstrap bridge IPC"
        return 1
    fi

    attempted_recompile=1

    if ! trigger_editor_refresh_only; then
        bridge_result_success=0
        bridge_result_errors="Failed to trigger Unity editor refresh for bridge bootstrap"
        return 1
    fi

    if ! wait_for_bridge_ready "$BRIDGE_READY_TIMEOUT_SECS"; then
        bridge_result_success=0
        bridge_result_errors="Bridge did not become ready after bootstrap refresh"
        return 1
    fi

    # Send handshake only after the target bridge version is ready; otherwise an older bridge may consume it.
    if ! bridge_request_and_wait "bootstrap_handshake" "$BRIDGE_READY_TIMEOUT_SECS"; then
        return 1
    fi

    log "Bridge bootstrap handshake succeeded, requesting authoritative recompile"
    if ! bridge_request_and_wait "recompile" "$BRIDGE_STATUS_TIMEOUT_SECS"; then
        return 1
    fi

    return 0
}

run_bridge_recompile_direct() {
    if ! unity_is_running; then
        return 1
    fi

    if ! bridge_ready_matches_project; then
        return 1
    fi

    attempted_recompile=1
    log "Bridge direct recompile flow"
    bridge_request_and_wait "recompile" "$BRIDGE_STATUS_TIMEOUT_SECS"
}

run_dotnet_format_lint() {
    if ! command -v dotnet &>/dev/null; then
        log "Lint: dotnet not found, skipping"
        return 0
    fi

    # Get changed .cs files (staged + unstaged vs HEAD)
    local changed_files
    changed_files=$(git -C "$project_path" diff HEAD --name-only -- '*.cs' 2>/dev/null || true)
    if [[ -z "$changed_files" ]]; then
        log "Lint: no changed .cs files, skipping"
        return 0
    fi

    # Check at least one .csproj exists in project root
    local has_csproj
    has_csproj=$(find "$project_path" -maxdepth 1 -name "*.csproj" -print -quit 2>/dev/null || true)
    if [[ -z "$has_csproj" ]]; then
        log "Lint: no .csproj files found, skipping"
        return 0
    fi

    # Group changed files by their .csproj using temp dir (bash 3.2 compatible)
    local tmp_dir
    tmp_dir=$(mktemp -d)

    while IFS= read -r file; do
        local csproj
        csproj=$(grep -l "\"$file\"" "$project_path"/*.csproj 2>/dev/null | head -1)
        if [[ -n "$csproj" ]]; then
            echo "$file" >> "$tmp_dir/$(basename "$csproj")"
        fi
    done <<< "$changed_files"

    # Count unique projects
    local project_count=0
    for group_file in "$tmp_dir"/*; do
        [[ -f "$group_file" ]] || continue
        ((project_count++))
    done

    if [[ "$project_count" -eq 0 ]]; then
        log "Lint: no files matched any .csproj, skipping"
        rm -rf "$tmp_dir"
        return 0
    fi

    local file_count
    file_count=$(echo "$changed_files" | wc -l | tr -d ' ')
    log "Lint: formatting $file_count file(s) across $project_count project(s)"

    # Run dotnet format per project in parallel
    for group_file in "$tmp_dir"/*; do
        [[ -f "$group_file" ]] || continue
        local include_arg
        include_arg=$(paste -sd, - < "$group_file")
        local csproj_path="$project_path/$(basename "$group_file")"
        log "Lint: dotnet format $(basename "$group_file") --include $include_arg"
        dotnet format "$csproj_path" --include "$include_arg" \
            --severity warn --no-restore --verbosity quiet 2>/dev/null &
    done
    wait

    rm -rf "$tmp_dir"
    log "Lint: done"
}

# Main logic
log "Checking if Unity is running for project: $project_path"

ensure_local_git_exclude_for_bridge
mkdir -p "$BRIDGE_IPC_DIR"
ensure_bridge_installed

errors=""
result_via_bridge=0

if unity_is_running; then
    log "Unity IS running"

    # Always use bridge status as authoritative result channel when editor is running.
    if [[ "$bridge_changed_this_run" -eq 1 ]]; then
        log "Bridge changed this run; using bootstrap trigger-only flow + bridge status"
        if run_bridge_bootstrap_and_recompile; then
            result_via_bridge=1
        else
            result_via_bridge=1
        fi
    elif bridge_ready_matches_project; then
        log "Bridge ready; using direct bridge path"
        if run_bridge_recompile_direct; then
            result_via_bridge=1
        else
            result_via_bridge=1
        fi
    else
        log "Bridge not ready; using bootstrap trigger-only flow + bridge status"
        if run_bridge_bootstrap_and_recompile; then
            result_via_bridge=1
        else
            result_via_bridge=1
        fi
    fi

    if [[ "$result_via_bridge" -eq 1 ]]; then
        if [[ "$bridge_result_success" -eq 1 ]]; then
            errors=""
        else
            errors="$bridge_result_errors"
        fi
    else
        # Should not happen with the current control flow, but keep explicit failure.
        errors="Bridge flow did not execute"
    fi
else
    log "Unity NOT running, using CLI fallback"
    attempted_recompile=1
    legacy_errors=$(run_cli_fallback)
    errors="$legacy_errors"
fi

# Touch marker file — recompilation attempted (success or failure)
if [[ "$attempted_recompile" -eq 1 ]]; then
    touch "$marker_file"
    log "Marker file updated: $marker_file"
fi

# Output results
if [[ -z "$errors" ]]; then
    log "SUCCESS: Unity recompilation complete"
    echo "Unity compiled successfully" >&2
    (run_dotnet_format_lint </dev/null >/dev/null 2>/dev/null &)
    exit 0
else
    log "FAILED: Unity compilation errors found"
    echo "Unity compilation failed:" >&2
    echo "" >&2
    echo "$errors" >&2
    echo "" >&2
    echo "Fix these errors to continue." >&2
    exit 2
fi
