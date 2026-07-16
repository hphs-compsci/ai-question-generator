import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { specToJobs, parseQuestions, reconcileWithSelfReport } from "../src";

// These cover request validation only. Generation itself calls the remote AI
// binding (slow + billable), so it is exercised manually / in integration, not
// in unit tests.
describe("question generator — validation", () => {
  async function get(url) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(url), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("requires both query params", async () => {
    const res = await get("http://example.com/");
    expect(res.status).toBe(400);
  });

  it("rejects a question number outside 1-15", async () => {
    const res = await get("http://example.com/?question=99&quantity=2");
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer question", async () => {
    const res = await get("http://example.com/?question=2.5&quantity=2");
    expect(res.status).toBe(400);
  });

  it("rejects quantity above the max", async () => {
    const res = await get("http://example.com/?question=2&quantity=999");
    expect(res.status).toBe(400);
  });

  it("rejects quantity below 1", async () => {
    const res = await get("http://example.com/?question=2&quantity=0");
    expect(res.status).toBe(400);
  });

  it("rejects a JSON body that is not an object", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[1,2]",
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});

describe("parseQuestions — tolerant parsing of model output", () => {
  const payload = { questions: [{ stem: "s", code: "c", choices: {}, answer: "A", explanation: "e" }] };

  it("parses clean JSON", () => {
    expect(parseQuestions(JSON.stringify(payload))).toEqual(payload);
  });

  it("unwraps a ```json markdown fence", () => {
    expect(parseQuestions("```json\n" + JSON.stringify(payload) + "\n```")).toEqual(payload);
  });

  it("unwraps a bare ``` fence", () => {
    expect(parseQuestions("```\n" + JSON.stringify(payload) + "\n```")).toEqual(payload);
  });

  it("recovers JSON surrounded by prose", () => {
    expect(parseQuestions("Sure! Here you go:\n" + JSON.stringify(payload) + "\nHope that helps.")).toEqual(payload);
  });

  it("returns null for truncated JSON", () => {
    expect(parseQuestions('{"questions":[{"stem":"s","code":"out.print(')).toBeNull();
  });

  it("returns null when there is no questions array", () => {
    expect(parseQuestions('{"foo":1}')).toBeNull();
    expect(parseQuestions("not json at all")).toBeNull();
  });
});

describe("reconcileWithSelfReport — model's own output vs its chosen letter", () => {
  const base = { choices: { A: "10", B: "15", C: "20", D: "25", E: "30" } };

  it("leaves a self-consistent question alone", () => {
    expect(reconcileWithSelfReport({ ...base, output: "15", answer: "B" }))
      .toMatchObject({ status: "consistent" });
  });

  it("fixes the letter when output points at a different choice", () => {
    // The 'wrong letter, right explanation' case: it computed 15 but said C.
    expect(reconcileWithSelfReport({ ...base, output: "15", answer: "C" }))
      .toMatchObject({ status: "corrected", answer: "B" });
  });

  it("ignores whitespace differences", () => {
    const q = { choices: { A: "306 2", B: "x", C: "y", D: "z", E: "w" }, output: "306\n2", answer: "B" };
    expect(reconcileWithSelfReport(q)).toMatchObject({ status: "corrected", answer: "A" });
  });

  it("stays hands-off when output matches no choice", () => {
    // Can't tell whether output or the choices are at fault; don't guess.
    expect(reconcileWithSelfReport({ ...base, output: "99", answer: "A" }))
      .toMatchObject({ status: "consistent" });
  });

  it("stays hands-off when the model reported no output", () => {
    expect(reconcileWithSelfReport({ ...base, answer: "A" })).toMatchObject({ status: "consistent" });
    expect(reconcileWithSelfReport({ ...base, output: "  ", answer: "A" })).toMatchObject({ status: "consistent" });
  });
});

describe("specToJobs — per-topic count map", () => {
  it("builds sorted jobs and skips zero counts", () => {
    const { jobs, error } = specToJobs({ "2": 2, "1": 1, "13": 3, "3": 0 });
    expect(error).toBeUndefined();
    expect(jobs).toEqual([
      { topic: 1, quantity: 1 },
      { topic: 2, quantity: 2 },
      { topic: 13, quantity: 3 },
    ]);
  });

  it("rejects an out-of-range topic", () => {
    expect(specToJobs({ "99": 1 }).error).toMatch(/Invalid topic/);
  });

  it("rejects an out-of-range count", () => {
    expect(specToJobs({ "1": 99 }).error).toMatch(/Invalid count/);
    expect(specToJobs({ "1": -1 }).error).toMatch(/Invalid count/);
  });

  it("errors when nothing is requested", () => {
    expect(specToJobs({ "1": 0, "2": 0 }).error).toMatch(/No questions requested/);
  });

  it("rejects non-object specs", () => {
    expect(specToJobs([1, 2]).error).toBeDefined();
    expect(specToJobs(null).error).toBeDefined();
    expect(specToJobs("x").error).toBeDefined();
  });
});
