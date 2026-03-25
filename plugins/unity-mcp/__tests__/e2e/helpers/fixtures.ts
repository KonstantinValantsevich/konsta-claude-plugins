/**
 * Valid MonoBehaviour script.
 */
export function simpleMonoBehaviour(className: string): string {
  return `using UnityEngine;

public class ${className} : MonoBehaviour
{
    void Start()
    {
        Debug.Log("${className} started");
    }
}
`;
}

/**
 * C# file with a syntax error (missing semicolon).
 */
export function compileErrorScript(): string {
  return `using UnityEngine;

public class BrokenScript : MonoBehaviour
{
    void Start()
    {
        Debug.Log("broken")
    }
}
`;
}

/**
 * EditMode test class with a passing [Test] method.
 * Optional [Category] attribute.
 */
export function passingEditModeTest(
  className: string,
  category?: string,
): string {
  const categoryAttr = category ? `\n    [NUnit.Framework.Category("${category}")]` : "";
  return `using NUnit.Framework;

public class ${className}
{
    [Test]${categoryAttr}
    public void PassingTest()
    {
        Assert.Pass();
    }
}
`;
}

/**
 * EditMode test class with a failing [Test] method.
 */
export function failingEditModeTest(className: string): string {
  return `using NUnit.Framework;

public class ${className}
{
    [Test]
    public void FailingTest()
    {
        Assert.Fail("intentional failure");
    }
}
`;
}

/**
 * Assembly definition JSON for EditMode tests.
 * Required for Unity to discover test classes.
 */
export function editModeTestAsmdef(): string {
  return JSON.stringify(
    {
      name: "Tests",
      rootNamespace: "",
      references: ["UnityEngine.TestRunner", "UnityEditor.TestRunner"],
      includePlatforms: ["Editor"],
      excludePlatforms: [],
      allowUnsafeCode: false,
      overrideReferences: true,
      precompiledReferences: ["nunit.framework.dll"],
      autoReferenced: false,
      defineConstraints: ["UNITY_INCLUDE_TESTS"],
      versionDefines: [],
      noEngineReferences: false,
    },
    null,
    2,
  );
}

/**
 * Baseline for brace atomicity test — brace-less control flow spread across
 * the file so some statements are near the edit and some are far away.
 */
export function braceTestBaseline(): string {
  return `using UnityEngine;

public class BraceAtomic : MonoBehaviour
{
    private int value = 5;
    private int count = 3;

    void Start()
    {
        Debug.Log("start");
    }

    void Update()
    {
        if (value > 10)
            Debug.Log("high");

        value = Calculate(value);
    }

    int Calculate(int v)
    {
        return v + 1;
    }

    void ProcessInput()
    {
        for (int i = 0; i < value; i++)
            Debug.Log(i);
    }

    void Cleanup()
    {
        while (count > 0)
            count--;

        Debug.Log("done");
    }
}
`;
}

/**
 * Edited version of braceTestBaseline — single line change inside Update().
 * The nearby if (line ~17) should get braces; the far-away while (~38) should not.
 */
export function braceTestEdited(): string {
  return `using UnityEngine;

public class BraceAtomic : MonoBehaviour
{
    private int value = 5;
    private int count = 3;

    void Start()
    {
        Debug.Log("start");
    }

    void Update()
    {
        if (value > 10)
            Debug.Log("high");

        value = Calculate(value) * 2;
    }

    int Calculate(int v)
    {
        return v + 1;
    }

    void ProcessInput()
    {
        for (int i = 0; i < value; i++)
            Debug.Log(i);
    }

    void Cleanup()
    {
        while (count > 0)
            count--;

        Debug.Log("done");
    }
}
`;
}

/**
 * Badly formatted C# script that violates many DotSettings rules.
 * Used by Phase 04 (lint) to verify JetBrains cleanup.
 */
export function badlyFormattedScript(): string {
  return `using System;
using System.Collections.Generic;
using UnityEngine;
namespace  BadFormatting{
public class LintTest:MonoBehaviour{
  [SerializeField]  private  static readonly int BadField=42;
  [SerializeField] int anotherField = 10;
    static public void  BadMethod( string arg1,int arg2 ){
    if(arg1 == null)
      Debug.Log("no braces");
    for(int i=0;i<arg2;i++)
      Debug.Log(i);
    foreach(var item in new List<int>{1,2,3})
      Debug.Log(item);
    while(arg2>0)
      arg2--;
    var x = new Dictionary<string,int>(){{"a",1},{"b",2}};
    Debug.Log( $"test" ); Debug.Log("same line");
    }


public void AnotherMethod(){} public void ThirdMethod(){}
}
}
`;
}
