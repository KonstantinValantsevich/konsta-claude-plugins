// ClaudeTestHandler Version: 4
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

internal static class ClaudeTestHandler
{
    [Serializable]
    private class TestRunPayload
    {
        public string[] categoryNames;
        public string[] groupNames;
        public string[] assemblyNames;
    }

    [Serializable]
    private class TestResultsPayload
    {
        public int totalCount;
        public int passCount;
        public int failCount;
        public int skipCount;
        public int inconclusiveCount;
        public double duration;
        public List<TestResultEntry> tests;
    }

    [Serializable]
    private class TestResultEntry
    {
        public string fullName;
        public string name;
        public string status;
        public double duration;
        public string message;
        public string stackTrace;
        public string output;
    }

    private class ResultCollector : ICallbacks
    {
        public readonly List<TestResultEntry> Results = new List<TestResultEntry>();
        public int PassCount;
        public int FailCount;
        public int SkipCount;
        public int InconclusiveCount;
        public double TotalDuration;

        public void RunStarted(ITestAdaptor testsToRun) { }
        public void TestStarted(ITestAdaptor test) { }

        public void TestFinished(ITestResultAdaptor result)
        {
            if (result.Test.IsSuite) return;

            var entry = new TestResultEntry
            {
                fullName = result.FullName ?? string.Empty,
                name = result.Name ?? string.Empty,
                status = result.TestStatus.ToString(),
                duration = result.Duration,
                message = result.Message,
                stackTrace = result.StackTrace,
                output = result.Output,
            };

            Results.Add(entry);

            switch (result.TestStatus)
            {
                case TestStatus.Passed: PassCount++; break;
                case TestStatus.Failed: FailCount++; break;
                case TestStatus.Skipped: SkipCount++; break;
                case TestStatus.Inconclusive: InconclusiveCount++; break;
            }

            TotalDuration += result.Duration;
        }

        public void RunFinished(ITestResultAdaptor result) { }
    }

    internal static void Register()
    {
        ClaudeBridgeBase.RegisterAction("run_tests", HandleRunTests);
    }

    private static void HandleRunTests(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);

        try
        {
            TestRunPayload filters = null;
            if (!string.IsNullOrEmpty(request.payload))
            {
                filters = JsonUtility.FromJson<TestRunPayload>(request.payload);
            }

            var filter = new Filter
            {
                testMode = TestMode.EditMode,
            };

            if (filters != null)
            {
                if (filters.categoryNames != null && filters.categoryNames.Length > 0)
                    filter.categoryNames = filters.categoryNames;
                if (filters.groupNames != null && filters.groupNames.Length > 0)
                    filter.groupNames = filters.groupNames;
                if (filters.assemblyNames != null && filters.assemblyNames.Length > 0)
                    filter.assemblyNames = filters.assemblyNames;
            }

            var settings = new ExecutionSettings(filter)
            {
                runSynchronously = true,
            };

            var collector = new ResultCollector();
            var api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.RegisterCallbacks(collector);

            api.Execute(settings);

            var resultsPayload = new TestResultsPayload
            {
                totalCount = collector.Results.Count,
                passCount = collector.PassCount,
                failCount = collector.FailCount,
                skipCount = collector.SkipCount,
                inconclusiveCount = collector.InconclusiveCount,
                duration = collector.TotalDuration,
                tests = collector.Results,
            };

            string resultsJson = JsonUtility.ToJson(resultsPayload, true);

            ClaudeBridgeBase.WriteStatus(
                request, "tests_finished", false,
                collector.FailCount == 0,
                collector.FailCount == 0
                    ? "All tests passed (" + collector.Results.Count + " total)"
                    : collector.FailCount + " test(s) failed out of " + collector.Results.Count,
                null,
                resultsJson
            );
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "Test run failed: " + ex.Message);
        }
        finally
        {
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }
}
