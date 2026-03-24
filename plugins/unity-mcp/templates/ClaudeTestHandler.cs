// ClaudeTestHandler Version: 5
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

        public ClaudeBridgeBase.RequestPayload Request;

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

        public void RunFinished(ITestResultAdaptor result)
        {
            try
            {
                var resultsPayload = new TestResultsPayload
                {
                    totalCount = Results.Count,
                    passCount = PassCount,
                    failCount = FailCount,
                    skipCount = SkipCount,
                    inconclusiveCount = InconclusiveCount,
                    duration = TotalDuration,
                    tests = Results,
                };

                string resultsJson = JsonUtility.ToJson(resultsPayload, true);

                ClaudeBridgeBase.WriteStatus(
                    Request, "tests_finished", false,
                    FailCount == 0,
                    FailCount == 0
                        ? "All tests passed (" + Results.Count + " total)"
                        : FailCount + " test(s) failed out of " + Results.Count,
                    null,
                    resultsJson
                );
            }
            catch (Exception ex)
            {
                ClaudeBridgeBase.WriteStatus(Request, "failed", false, false, "Test run failed: " + ex.Message);
            }
            finally
            {
                ClaudeBridgeBase.FinalizeRequest(Request);
            }
        }
    }

    internal static void Register()
    {
        ClaudeBridgeBase.RegisterAction("run_tests", HandleRunTests);
        ClaudeBridgeBase.RegisterAction("list_tests", HandleListTests);
    }

    private static Filter BuildFilter(TestRunPayload filters)
    {
        var filter = new Filter { testMode = TestMode.EditMode };
        if (filters != null)
        {
            if (filters.categoryNames != null && filters.categoryNames.Length > 0)
                filter.categoryNames = filters.categoryNames;
            if (filters.groupNames != null && filters.groupNames.Length > 0)
                filter.groupNames = filters.groupNames;
            if (filters.assemblyNames != null && filters.assemblyNames.Length > 0)
                filter.assemblyNames = filters.assemblyNames;
        }
        return filter;
    }

    [Serializable]
    private class TestListEntry
    {
        public string fullName;
        public string name;
        public string[] categories;
        public string assembly;
    }

    [Serializable]
    private class TestListPayload
    {
        public int totalCount;
        public int matchedCount;
        public List<TestListEntry> tests;
    }

    private static void CollectLeafTests(ITestAdaptor node, List<TestListEntry> results, string currentAssembly = null)
    {
        if (node.IsSuite && node.Parent == null && node.Children != null)
        {
            foreach (var child in node.Children)
            {
                CollectLeafTests(child, results, child.IsSuite ? child.Name : currentAssembly);
            }
            return;
        }

        if (node.IsSuite && node.Children != null)
        {
            string assembly = currentAssembly ?? node.Name;
            foreach (var child in node.Children)
            {
                CollectLeafTests(child, results, assembly);
            }
            return;
        }

        if (!node.IsSuite)
        {
            var categories = new List<string>();
            if (node.Categories != null)
            {
                foreach (var cat in node.Categories)
                    categories.Add(cat);
            }

            results.Add(new TestListEntry
            {
                fullName = node.FullName ?? string.Empty,
                name = node.Name ?? string.Empty,
                categories = categories.ToArray(),
                assembly = currentAssembly ?? string.Empty,
            });
        }
    }

    private static List<TestListEntry> FilterTestEntries(List<TestListEntry> tests, TestRunPayload filters)
    {
        if (filters == null)
            return new List<TestListEntry>(tests);

        var result = new List<TestListEntry>();
        foreach (var test in tests)
        {
            bool match = true;

            // categoryNames: OR — test has at least one matching category
            if (filters.categoryNames != null && filters.categoryNames.Length > 0)
            {
                bool catMatch = false;
                if (test.categories != null)
                {
                    foreach (var cat in test.categories)
                    {
                        foreach (var filterCat in filters.categoryNames)
                        {
                            if (string.Equals(cat, filterCat, StringComparison.Ordinal))
                            {
                                catMatch = true;
                                break;
                            }
                        }
                        if (catMatch) break;
                    }
                }
                if (!catMatch) match = false;
            }

            // groupNames: OR — fullName matches at least one regex
            if (match && filters.groupNames != null && filters.groupNames.Length > 0)
            {
                bool groupMatch = false;
                foreach (var pattern in filters.groupNames)
                {
                    try
                    {
                        if (System.Text.RegularExpressions.Regex.IsMatch(test.fullName, pattern))
                        {
                            groupMatch = true;
                            break;
                        }
                    }
                    catch (Exception) { /* invalid regex — skip */ }
                }
                if (!groupMatch) match = false;
            }

            // assemblyNames: OR — test assembly is in list
            if (match && filters.assemblyNames != null && filters.assemblyNames.Length > 0)
            {
                bool asmMatch = false;
                foreach (var asm in filters.assemblyNames)
                {
                    if (string.Equals(test.assembly, asm, StringComparison.Ordinal))
                    {
                        asmMatch = true;
                        break;
                    }
                }
                if (!asmMatch) match = false;
            }

            if (match) result.Add(test);
        }

        return result;
    }

    private static void HandleListTests(ClaudeBridgeBase.RequestPayload request, long createdAtUnixMs)
    {
        ClaudeBridgeBase.MarkBusy(request.requestId);
        try
        {
            TestRunPayload filters = null;
            if (!string.IsNullOrEmpty(request.payload))
                filters = JsonUtility.FromJson<TestRunPayload>(request.payload);

            var api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.RetrieveTestList(TestMode.EditMode, (testRoot) =>
            {
                var allTests = new List<TestListEntry>();
                CollectLeafTests(testRoot, allTests);

                var matched = FilterTestEntries(allTests, filters);

                var payload = new TestListPayload
                {
                    totalCount = allTests.Count,
                    matchedCount = matched.Count,
                    tests = matched,
                };

                ClaudeBridgeBase.WriteStatus(
                    request, "list_tests_finished", false, true,
                    matched.Count + " test(s) matched out of " + allTests.Count + " total",
                    null,
                    JsonUtility.ToJson(payload, true)
                );
                ClaudeBridgeBase.FinalizeRequest(request);
            });
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "List tests failed: " + ex.Message);
            ClaudeBridgeBase.FinalizeRequest(request);
        }
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

            var filter = BuildFilter(filters);

            var settings = new ExecutionSettings(filter)
            {
                runSynchronously = false,
            };

            var collector = new ResultCollector { Request = request };
            var api = ScriptableObject.CreateInstance<TestRunnerApi>();
            api.RegisterCallbacks(collector);

            api.Execute(settings);
        }
        catch (Exception ex)
        {
            ClaudeBridgeBase.WriteStatus(request, "failed", false, false, "Test run failed: " + ex.Message);
            ClaudeBridgeBase.FinalizeRequest(request);
        }
    }
}
