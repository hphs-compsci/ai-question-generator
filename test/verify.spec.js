import { describe, it, expect } from "vitest";
import { verifyQuestion, findStructuralProblem, __test } from "../src/verify.js";

const { evaluateSnippet } = __test;

describe("evaluateSnippet — Java semantics", () => {
  it("truncates integer division toward zero", () => {
    expect(evaluateSnippet("out.print(5 / 4);")).toBe("1");
    expect(evaluateSnippet("out.print(15 + 5 / 4 + 1);")).toBe("17");
    expect(evaluateSnippet("out.print(212 / 43 - 394 / 63);")).toBe("-2");
  });

  it("applies operator precedence and modulo", () => {
    expect(evaluateSnippet("out.print(22 / 7 + 15 % 8);")).toBe("10");
    expect(evaluateSnippet("out.print(35 % 12 / 4 + 27 * 2 % 4);")).toBe("4");
    expect(evaluateSnippet("out.println(1 + 2 * 3 - 4 / 5);")).toBe("7");
  });

  it("prints whole doubles with a trailing .0", () => {
    expect(evaluateSnippet("out.print(23 + 34 % 7 * 2);")).toBe("35"); // int stays int
    expect(evaluateSnippet("double x = 2.0; out.print(x + 3);")).toBe("5.0");
  });

  it("promotes to double when any operand is double", () => {
    expect(evaluateSnippet("out.print(7.5 / 2);")).toBe("3.75");
    expect(evaluateSnippet("double b = 3.0; out.print(1 / b);")).toBe("0.3333333333333333");
  });

  it("handles declarations feeding an output statement", () => {
    expect(
      evaluateSnippet("int a = 15;\nint b = 4;\nint c = 3;\nint r = a + b * c - a / b;\nout.println(r);"),
    ).toBe("24");
  });

  it("evaluates bitwise and shift operators as 32-bit ints", () => {
    expect(evaluateSnippet("out.println((-17 % 7) | (11 << 3));")).toBe("-3");
    expect(evaluateSnippet("out.print(~0);")).toBe("-1");
  });

  it("evaluates boolean logic", () => {
    expect(evaluateSnippet("boolean x = true; boolean y = false; out.print(x && !y);")).toBe("true");
    expect(evaluateSnippet("out.print(true ^ false);")).toBe("true");
  });

  it("rejects unsupported code as unverifiable (throws)", () => {
    expect(() => evaluateSnippet("int a = 5; out.print(a++);")).toThrow();
    expect(() => evaluateSnippet("for(int i=0;i<3;i++) out.print(i);")).toThrow();
    expect(() => evaluateSnippet("if(true) out.print(1);")).toThrow();
  });

  it("evaluates string methods and concatenation", () => {
    expect(evaluateSnippet('out.print("Programming".substring(3, 7));')).toBe("gram");
    expect(evaluateSnippet('out.print("abc".length());')).toBe("3");
    expect(evaluateSnippet('out.print("abc".toUpperCase());')).toBe("ABC");
    expect(evaluateSnippet('out.print("A" + 14 + "B");')).toBe("A14B");
    expect(evaluateSnippet("out.print('A' + 'B');")).toBe("131"); // char arithmetic
    expect(evaluateSnippet('out.print("hello".replace(\'l\', \'x\'));')).toBe("hexxo");
    expect(evaluateSnippet('out.print("Scholastic".indexOf("c", 2));')).toBe("9");
  });

  it("evaluates casts, hex/binary literals, and static methods", () => {
    expect(evaluateSnippet("out.print((int)(3.5 * 2));")).toBe("7");
    expect(evaluateSnippet("int h = 0x3A; out.print(h);")).toBe("58");
    expect(evaluateSnippet('out.print(Integer.parseInt("1101", 2));')).toBe("13");
    expect(evaluateSnippet("out.print(Math.pow(Math.floor(16.7), Math.abs(-3)));")).toBe("4096.0");
    expect(evaluateSnippet("out.print(Math.max(3, 7));")).toBe("7");
  });

  it("joins multiple output statements, placing println's newline after its value", () => {
    // print(30) then println(6) then print(2): "30" + "6" + "\n" + "2".
    expect(evaluateSnippet("out.print(30);\nout.println(6);\nout.print(2);")).toBe("306\n2");
  });
});

describe("findStructuralProblem — checks that apply to every question", () => {
  const good = { choices: { A: "1", B: "2", C: "3", D: "4", E: "5" }, answer: "A" };

  it("passes a well-formed question", () => {
    expect(findStructuralProblem(good)).toBeNull();
  });

  it("catches duplicate choices", () => {
    const q = { ...good, choices: { A: "45", B: "2", C: "3", D: "4", E: "45" } };
    expect(findStructuralProblem(q)).toMatch(/duplicate choices A and E/);
  });

  it("catches duplicates that differ only in whitespace", () => {
    const q = { ...good, choices: { A: "10 20", B: "2", C: "3", D: "4", E: "10  20" } };
    expect(findStructuralProblem(q)).toMatch(/duplicate/);
  });

  it("catches missing or blank choices", () => {
    expect(findStructuralProblem({ ...good, choices: { A: "1", B: "2", C: "3", D: "4" } })).toMatch(/missing choice/);
    expect(findStructuralProblem({ ...good, choices: { A: "1", B: "", C: "3", D: "4", E: "5" } })).toMatch(/missing choice/);
  });

  it("catches an answer outside A-E", () => {
    expect(findStructuralProblem({ ...good, answer: "F" })).toMatch(/not one of A-E/);
  });

  it("rejects a question with duplicate choices even if the code is unverifiable", () => {
    const q = {
      code: "ArrayList<Integer> list = new ArrayList<>();\nout.println(list);",
      choices: { A: "[]", B: "[]", C: "x", D: "y", E: "z" },
      answer: "A",
    };
    // Structural check runs before evaluation, so this is rejected rather than
    // passed through as unverifiable.
    expect(verifyQuestion(q)).toMatchObject({ status: "wrong" });
  });
});

describe("verifyQuestion — reconciliation", () => {
  const base = {
    code: "out.print(8 / 2 + 3 * 4 - 6);", // = 10
    choices: { A: "8", B: "10", C: "12", D: "16", E: "20" },
  };

  it("confirms a correctly labeled answer", () => {
    expect(verifyQuestion({ ...base, answer: "B" })).toMatchObject({ status: "ok" });
  });

  it("corrects a mislabeled answer to the matching choice", () => {
    expect(verifyQuestion({ ...base, answer: "A" })).toMatchObject({
      status: "corrected",
      answer: "B",
    });
  });

  it("flags a question whose choices never match the true output", () => {
    const q = { code: "out.print(2 + 2);", choices: { A: "1", B: "2", C: "3", D: "5", E: "6" }, answer: "A" };
    expect(verifyQuestion(q)).toMatchObject({ status: "wrong", expected: "4" });
  });

  it("returns unverifiable for code outside the supported subset", () => {
    const q = {
      code: 'out.print("x".repeat(3));',
      choices: { A: "xxx", B: "xx", C: "x", D: "xxxx", E: "error" },
      answer: "A",
    };
    expect(verifyQuestion(q)).toMatchObject({ status: "unverifiable" });
  });

  it("matches multi-line println output against space-rendered choices", () => {
    // Java prints "306\n2"; a bank renders that newline as a space: "306 2".
    const q = {
      code: "out.print(30);\nout.println(6);\nout.print(2);",
      choices: { A: "306 2", B: "3062", C: "306", D: "38", E: "12" },
      answer: "A",
    };
    expect(verifyQuestion(q)).toMatchObject({ status: "ok" });
  });

  it("corrects a mislabeled string-method answer", () => {
    const q = {
      code: 'out.print("Programming".substring(3, 7));',
      choices: { A: "gram", B: "gramm", C: "ogram", D: "Prog", E: "ming" },
      answer: "C",
    };
    expect(verifyQuestion(q)).toMatchObject({ status: "corrected", answer: "A" });
  });
});
