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

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "deepseek/deepseek-v4-flash";
// Preference-ordered providers with fallback. All of these were measured
// returning valid strict json_schema output; ordering is by observed latency.
// Fallbacks are essential rather than optional: Fireworks rate-limits (429)
// even on single sequential calls, so pinning one provider fails most requests.
const PROVIDER = {
  order: ["DeepInfra", "Parasail", "AtlasCloud", "Alibaba", "Fireworks"],
  allow_fallbacks: true,
};
// The model already emits reasoning tokens by default; forcing an explicit
// `reasoning.effort` measured slower with no accuracy gain, so we leave it off.

const MAX_QUANTITY = 10;
// Cap on few-shot examples sent to the model. The banks hold ~20 questions
// each; sending all of them makes the prompt large and the request slow, so we
// sample a spread of them instead.
const MAX_EXAMPLES = 4;
// In `all=true` mode we generate for every topic. Fan them out, but cap how
// many inference calls are in flight at once so we don't trip upstream rate
// limits — each wave is ~one call's worth of latency.
const TOPIC_NUMBERS = Object.keys(BANKS).map(Number).sort((a, b) => a - b);
const ALL_CONCURRENCY = 5;
// Total attempts per topic before giving up (initial try + retries). Provider
// fallback handles most rate limiting upstream, so this only needs to cover a
// transient failure across the whole provider pool.
const AI_MAX_ATTEMPTS = 3;
const AI_RETRY_BASE_MS = 1000;

// JSON Schema constraining the model's output. Strict mode requires every
// object to declare `additionalProperties: false` and list all keys in
// `required`, so keep those in sync when editing.
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
      additionalProperties: false,
    },
    answer: { type: "string", enum: ["A", "B", "C", "D", "E"] },
    explanation: { type: "string" },
  },
  required: ["stem", "code", "choices", "answer", "explanation"],
  additionalProperties: false,
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
  additionalProperties: false,
};

function badRequest(message) {
  return Response.json({ error: message }, { status: 400 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The response schema, with the array length pinned to what was asked for.
// Without min/maxItems the model freely returns fewer (or more) than requested.
function buildResponseSchema(quantity) {
  return {
    ...RESPONSE_SCHEMA,
    properties: {
      questions: { ...RESPONSE_SCHEMA.properties.questions, minItems: quantity, maxItems: quantity },
    },
  };
}

// Parse the model's completion into { questions: [...] }, tolerating the two
// ways providers deviate from strict JSON: wrapping it in a markdown fence, and
// padding it with prose. Returns null if nothing usable can be recovered.
export function parseQuestions(content) {
  const attempt = (text) => {
    try {
      const obj = JSON.parse(text);
      return Array.isArray(obj?.questions) ? obj : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(content);
  if (direct) return direct;

  // ```json ... ``` (or a bare ``` fence)
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inner = attempt(fenced[1].trim());
    if (inner) return inner;
  }

  // Fall back to the outermost {...} span, in case of leading/trailing prose.
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const span = attempt(content.slice(first, last + 1));
    if (span) return span;
  }

  return null;
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
    `- Return EXACTLY ${quantity} question${quantity === 1 ? "" : "s"} — no more, no fewer.`,
    "- Each question must have a stem, a Java 'code' snippet, five choices A-E, one correct 'answer', and an 'explanation' that shows the work.",
    "- The 'code' is the Java segment the question asks about. Use '\\n' for newlines. Output statements use out.print / out.println / out.printf.",
    "- Exactly one of the five choices must be correct and equal to the true result of the code. Make the other four plausible distractors.",
    "- The five choices must be FIVE DISTINCT values. Never repeat a value across two letters.",
    "- Distractors must be wrong. Never include a second choice that is also equal to the true result.",
    "- Do NOT copy the example questions. Change the values, expressions, and structure so each question is genuinely new.",
    "- Keep each 'code' snippet short and self-contained, and keep 'explanation' brief.",
    "Accuracy is critical. For each question, before writing the choices:",
    "  1. Mentally execute the code step by step, exactly as Java would (integer vs. double division, operator precedence, %, bit ops, overflow).",
    "  2. Determine the single true result.",
    "  3. Put that exact result as one of the five choices and set 'answer' to that choice's letter.",
    "  4. Verify that choices[answer] equals the value your explanation computes. They MUST match.",
    "  5. Check the other four choices: each must be DIFFERENT from the answer and from each other.",
    "The explanation must show the step-by-step evaluation and end at the value in the chosen answer.",
  ].join("\n");

  const userPrompt = [
    `Here are ${examples.length} example questions on "${bank.topic}":`,
    "",
    JSON.stringify(examples, null, 2),
    "",
    `Now generate ${quantity} NEW original question(s) on the same topic, in the same JSON format.`,
  ].join("\n");

  const body = {
    model: MODEL,
    provider: PROVIDER,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // Token budget. Reasoning tokens count against this and vary a lot by
    // provider (measured 0 on some, >2000 on others), so leave generous
    // headroom: running out truncates the JSON mid-object and it won't parse.
    max_tokens: Math.min(16384, 3000 + quantity * 1200),
    response_format: {
      type: "json_schema",
      json_schema: { name: "questions", strict: true, schema: buildResponseSchema(quantity) },
    },
  };

  // One attempt at the whole round-trip: request, then parse. Parsing lives
  // inside the retry loop on purpose — a truncated or fenced response is just
  // as transient as a 429, and retrying is what keeps a topic from being lost.
  let generated;
  let lastErr;
  for (let attempt = 0; attempt < AI_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter. Jitter matters here: without it the
      // concurrent topic workers retry in lockstep and re-trigger rate limits.
      const backoff = AI_RETRY_BASE_MS * 2 ** (attempt - 1);
      await sleep(backoff + Math.random() * 1000);
    }
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        // 4xx other than 429 won't fix themselves (bad key, bad request).
        if (res.status !== 429 && res.status < 500) break;
        const retryAfter = Number(res.headers.get("retry-after"));
        if (retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 15000));
        continue;
      }
      const payload = await res.json();
      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        lastErr = "empty completion";
        continue;
      }
      // finish_reason "length" means the model was cut off mid-JSON. Don't
      // bother parsing; just retry.
      if (choice.finish_reason === "length") {
        lastErr = "response truncated (hit max_tokens)";
        continue;
      }
      const parsed = parseQuestions(content);
      if (!parsed) {
        lastErr = "malformed JSON from model";
        continue;
      }
      generated = parsed;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = String(err);
    }
  }
  if (lastErr) {
    return {
      question_number: questionNumber,
      topic: bank.topic,
      error: "AI generation failed.",
      detail: lastErr,
    };
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

    // Fail loudly on a misconfigured deploy rather than retrying into a 401.
    if (!env.OPENROUTER_API_KEY) {
      return Response.json(
        {
          error:
            "OPENROUTER_API_KEY is not configured. Set it with: npx wrangler secret put OPENROUTER_API_KEY",
        },
        { status: 500 },
      );
    }

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
