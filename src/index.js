import q01 from "../JSON/q01 - Number base concepts, arithmetic, conversion.json";
import q02 from "../JSON/q02 - Simple literal math expression with mixed operations.json";
import q03 from "../JSON/q03 - Simple output (print, println, printf).json";
import q04 from "../JSON/q04 - String class methods.json";
import q05 from "../JSON/q05 - Simple Boolean logic (AND, OR, XOR, NOT).json";
import q06 from "../JSON/q06 - Math class methods.json";
import q07 from "../JSON/q07 - Simple variable expression with mixed operations.json";
import q08 from "../JSON/q08 - Conditionals (if, if-else, switch).json";
import q09 from "../JSON/q09 - Simple output loop.json";
import q10 from "../JSON/q10 - 1D primitive array, basic concepts.json";
import q11 from "../JSON/q11 - Input concepts (Scanner and File classes).json";
import q12 from "../JSON/q12 - Accumulation loop (summation, product, etc.).json";
import q13 from "../JSON/q13 - Order of operations (full Java precedence).json";
import q14 from "../JSON/q14 - Java data type concepts (size, limits, wrap, complement).json";
import q15 from "../JSON/q15 - ArrayList (generics only).json";
import { verifyQuestion } from "./verify.js";

// Indexed by question number (1-15).
const BANKS = {
  1: q01, 2: q02, 3: q03, 4: q04, 5: q05,
  6: q06, 7: q07, 8: q08, 9: q09, 10: q10,
  11: q11, 12: q12, 13: q13, 14: q14, 15: q15,
};

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_QUANTITY = 10;
// Cap on few-shot examples sent to the model. The banks hold ~20 questions
// each; sending all of them makes the prompt large and the request slow, so we
// sample a spread of them instead.
const MAX_EXAMPLES = 4;
// In `all=true` mode we generate for every topic. Fan them out, but cap how
// many inference calls are in flight at once so we don't trip Workers AI rate
// limits — each wave is ~one call's worth of latency.
const TOPIC_NUMBERS = Object.keys(BANKS).map(Number).sort((a, b) => a - b);
const ALL_CONCURRENCY = 4;
// Total attempts per topic before giving up (initial try + retries). Guards
// against transient upstream 504s, which are common under concurrent load.
const AI_MAX_ATTEMPTS = 3;

// JSON Schema describing a single generated question. Passed to Workers AI so
// the model is constrained to return well-formed output.
const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    stem: { type: "string" },
    code: { type: "string" },
    choices: {
      type: "object",
      properties: {
        A: { type: "string" },
        B: { type: "string" },
        C: { type: "string" },
        D: { type: "string" },
        E: { type: "string" },
      },
      required: ["A", "B", "C", "D", "E"],
    },
    answer: { type: "string", enum: ["A", "B", "C", "D", "E"] },
    explanation: { type: "string" },
  },
  required: ["stem", "code", "choices", "answer", "explanation"],
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: QUESTION_SCHEMA,
    },
  },
  required: ["questions"],
};

function badRequest(message) {
  return Response.json({ error: message }, { status: 400 });
}

// Trim each example down to the fields that matter for generation. `source` is
// contest-specific and would only encourage the model to invent fake sources.
function toExample(q) {
  return {
    stem: q.stem,
    code: q.code,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation,
  };
}

// Pick up to `limit` questions evenly spread across the bank so the sample
// spans the range of difficulty/styles rather than just the first few.
function sampleExamples(questions, limit) {
  if (questions.length <= limit) return questions;
  const step = questions.length / limit;
  const picked = [];
  for (let i = 0; i < limit; i++) {
    picked.push(questions[Math.floor(i * step)]);
  }
  return picked;
}

// Build the prompt, call the model, and verify the result for one topic.
// Returns the same result object the single-topic endpoint responds with. Never
// throws — AI/parse failures are returned as an { error } object so a single bad
// topic can't sink an all-topics run.
async function generateTopic(env, questionNumber, quantity) {
  const bank = BANKS[questionNumber];
  const examples = sampleExamples(bank.questions, MAX_EXAMPLES).map(toExample);

  const systemPrompt = [
    "You are an author of UIL Computer Science multiple-choice questions for Java.",
    `Every question you write is on the topic: "${bank.topic}".`,
    "You are given existing questions as examples. Write brand-new original questions in the exact same style and difficulty.",
    "Rules:",
    "- Each question must have a stem, a Java 'code' snippet, five choices A-E, one correct 'answer', and an 'explanation' that shows the work.",
    "- The 'code' is the Java segment the question asks about. Use '\\n' for newlines. Output statements use out.print / out.println / out.printf.",
    "- Exactly one of the five choices must be correct and equal to the true result of the code. Make the other four plausible distractors.",
    "- Do NOT copy the example questions. Change the values, expressions, and structure so each question is genuinely new.",
    "Accuracy is critical. For each question, before writing the choices:",
    "  1. Mentally execute the code step by step, exactly as Java would (integer vs. double division, operator precedence, %, bit ops, overflow).",
    "  2. Determine the single true result.",
    "  3. Put that exact result as one of the five choices and set 'answer' to that choice's letter.",
    "  4. Verify that choices[answer] equals the value your explanation computes. They MUST match.",
    "The explanation must show the step-by-step evaluation and end at the value in the chosen answer.",
  ].join("\n");

  const userPrompt = [
    `Here are ${examples.length} example questions on "${bank.topic}":`,
    "",
    JSON.stringify(examples, null, 2),
    "",
    `Now generate ${quantity} NEW original question(s) on the same topic, in the same JSON format.`,
  ].join("\n");

  const runArgs = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // Budget roughly one question's worth of tokens per requested item,
    // clamped so a single-question request returns quickly.
    max_tokens: Math.min(4096, 400 + quantity * 350),
    response_format: {
      type: "json_schema",
      json_schema: RESPONSE_SCHEMA,
    },
  };

  // Inference calls occasionally time out (upstream 504), especially when
  // several run concurrently in an all-topics request. These are usually
  // transient, so retry a couple of times before giving up on the topic.
  let aiResponse;
  let lastErr;
  for (let attempt = 0; attempt < AI_MAX_ATTEMPTS; attempt++) {
    try {
      aiResponse = await env.AI.run(MODEL, runArgs);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    return {
      question_number: questionNumber,
      topic: bank.topic,
      error: "AI generation failed.",
      detail: String(lastErr),
    };
  }

  // With json_schema response_format, the model returns a parsed object in
  // `response`. Fall back to parsing a raw string if needed.
  let generated = aiResponse.response;
  if (typeof generated === "string") {
    try {
      generated = JSON.parse(generated);
    } catch {
      return {
        question_number: questionNumber,
        topic: bank.topic,
        error: "AI returned malformed JSON.",
      };
    }
  }

  const rawQuestions = Array.isArray(generated?.questions)
    ? generated.questions.slice(0, quantity)
    : [];

  // Independently evaluate each generated snippet with Java semantics and
  // reconcile it against the model's stated answer:
  //   ok           -> keep as-is (answer confirmed correct)
  //   corrected    -> fix the answer letter to the choice that truly matches
  //   wrong        -> drop it; no choice equals the real output, so it's junk
  //   unverifiable -> keep, but flag it (topic outside the evaluator's scope)
  const questions = [];
  let confirmed = 0;
  let corrected = 0;
  let dropped = 0;
  let unverified = 0;

  for (const q of rawQuestions) {
    const result = verifyQuestion(q);
    if (result.status === "ok") {
      confirmed++;
      questions.push({ ...q, verified: true });
    } else if (result.status === "corrected") {
      corrected++;
      questions.push({ ...q, answer: result.answer, verified: true });
    } else if (result.status === "wrong") {
      // The model produced choices none of which equal the real output.
      // There's nothing to salvage, so omit it from the response.
      dropped++;
    } else {
      unverified++;
      questions.push({ ...q, verified: false });
    }
  }

  return {
    question_number: questionNumber,
    topic: bank.topic,
    requested: quantity,
    generated: questions.length,
    verification: { confirmed, corrected, dropped, unverified },
    questions,
  };
}

// Run `task(item)` over items with at most `limit` in flight at once, invoking
// `onResult(result)` as each finishes (in completion order, not input order).
async function forEachWithConcurrency(items, limit, task, onResult) {
  const queue = [...items];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      const result = await task(item);
      await onResult(result);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// Stream a set of per-topic jobs as newline-delimited JSON. Each job is
// { topic, quantity }; its result is emitted the moment it finishes generating
// + verifying, so results appear progressively rather than after one long wait.
// Emission is in completion order, not job order.
function streamJobs(env, jobs) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      await forEachWithConcurrency(
        jobs,
        ALL_CONCURRENCY,
        (job) => generateTopic(env, job.topic, job.quantity),
        (result) => writer.write(encoder.encode(JSON.stringify(result) + "\n")),
      );
    } catch (err) {
      await writer.write(
        encoder.encode(JSON.stringify({ error: "stream failed", detail: String(err) }) + "\n"),
      );
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "transfer-encoding": "chunked",
    },
  });
}

// Turn a per-topic count map like { "1": 1, "2": 2, "13": 3 } into a validated
// list of { topic, quantity } jobs. Topics mapped to 0 (or omitted) are skipped.
// Returns { jobs } on success or { error } describing the first problem found.
export function specToJobs(spec) {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return { error: "Body must be a JSON object mapping topic number to count, e.g. {\"1\":1,\"2\":2}." };
  }
  const jobs = [];
  for (const key of Object.keys(spec)) {
    const topic = Number(key);
    if (!Number.isInteger(topic) || !(topic in BANKS)) {
      return { error: `Invalid topic '${key}': must be an integer from 1 to 15.` };
    }
    const quantity = spec[key];
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
      return { error: `Invalid count for topic ${topic}: must be an integer from 0 to ${MAX_QUANTITY}.` };
    }
    if (quantity > 0) jobs.push({ topic, quantity });
  }
  if (jobs.length === 0) {
    return { error: "No questions requested — set at least one topic's count above 0." };
  }
  // Emit lower topic numbers first among ready workers for predictable ordering.
  jobs.sort((a, b) => a.topic - b.topic);
  return { jobs };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Fine-grained mode: a JSON body maps topic -> how many questions to make.
    // e.g. { "1": 1, "2": 2, "13": 3 }  (topics set to 0/omitted are skipped).
    // Works on any method that carries a body; results stream as NDJSON.
    if (request.body && request.headers.get("content-type")?.includes("application/json")) {
      let spec;
      try {
        spec = await request.json();
      } catch {
        return badRequest("Request body is not valid JSON.");
      }
      const { jobs, error } = specToJobs(spec);
      if (error) return badRequest(error);
      return streamJobs(env, jobs);
    }

    // Convenience mode: same quantity for one topic, or for every topic.
    const quantityRaw = url.searchParams.get("quantity");
    const quantity = Number(quantityRaw);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return badRequest(
        `'quantity' must be an integer from 1 to ${MAX_QUANTITY}. ` +
          "For per-topic counts, POST a JSON body like {\"1\":1,\"2\":2,\"13\":3}.",
      );
    }

    // All-topics: `quantity` questions for every topic (1-15), streamed.
    if (url.searchParams.get("all") === "true") {
      const jobs = TOPIC_NUMBERS.map((topic) => ({ topic, quantity }));
      return streamJobs(env, jobs);
    }

    const questionRaw = url.searchParams.get("question");
    if (questionRaw === null) {
      return badRequest(
        "Provide 'question' (1-15) and 'quantity' (e.g. ?question=2&quantity=3), " +
          "'all=true&quantity=1' for every topic, or POST JSON {\"1\":1,\"2\":2} for per-topic counts.",
      );
    }
    const question = Number(questionRaw);
    if (!Number.isInteger(question) || question < 1 || question > 15) {
      return badRequest("'question' must be an integer from 1 to 15.");
    }

    const result = await generateTopic(env, question, quantity);
    const status = result.error ? 502 : 200;
    return Response.json(result, { status });
  },
};
