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
// Extra "think before answering" budget, opt-in per request via `?reasoning=`
// (low | medium | high). All five providers above accept it.
//
// It is off by default on purpose. This model already emits reasoning tokens
// unprompted, and the ordering of QUESTION_SCHEMA — work and output before
// answer — is what actually forces it to derive the result before naming a
// letter. Measured with that schema, the default produced 20/20 correct answers
// with zero wrong-letter corrections, while an explicit effort roughly doubled
// latency. Reach for this only if a topic proves stubbornly error-prone.
const REASONING_EFFORTS = ["low", "medium", "high"];

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
//
// Field ORDER matters and is deliberate. The model emits keys in this order, so
// putting `work` and `correct_choice_text` before `choices`/`answer` forces it
// to derive the result *before* it can name a letter. With `answer` ahead of the
// reasoning the model picks a letter first and rationalises after, which is
// exactly how a wrong answer ends up next to a correct explanation.
//
// `code` is intentionally NOT always required in spirit: several topics (most of
// all number bases) are prose questions with no snippet, so it may be empty.
const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    stem: { type: "string" },
    code: {
      type: "string",
      description:
        "The Java snippet the question asks about, or an empty string for concept questions that have no code (e.g. base-conversion problems where the values live in the choices).",
    },
    work: {
      type: "string",
      description:
        "Step-by-step derivation of the correct answer, one line per step. For code questions, trace the code exactly as Java would. Write this BEFORE deciding the choices.",
    },
    correct_choice_text: {
      type: "string",
      description:
        "The exact text of the correct choice, derived from 'work'. It must appear verbatim as one of the five choices below, written in the SAME notation the question uses (e.g. keep base-N literals such as 1101_2 in base-N form; do NOT convert them to decimal).",
    },
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
    answer: {
      type: "string",
      enum: ["A", "B", "C", "D", "E"],
      description: "The letter whose choice text is exactly equal to 'correct_choice_text'.",
    },
    explanation: { type: "string" },
  },
  required: ["stem", "code", "work", "correct_choice_text", "choices", "answer", "explanation"],
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

// Whitespace-insensitive comparison, matching how the banks render multi-line
// output with spaces instead of literal newlines.
const normalizeText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// For questions the Java evaluator can't run, use the model's own
// `correct_choice_text` (which it derived from its step-by-step 'work' before
// picking a letter) as a weaker cross-check against `choices[answer]`.
//
// This is deliberately conservative: it is still the model's word, not ground
// truth, so it is only trusted to detect a *self-contradiction*.
//   - it matches choices[answer]      -> consistent, leave alone
//   - it matches a different choice   -> the letter is wrong, fix it
//   - it matches no choice at all     -> the model derived a value it never put
//     in the choices, so no option is correct; drop the question
// Returns { status: "consistent" | "corrected" | "wrong", answer? }.
export function reconcileWithSelfReport(q) {
  const derived = normalizeText(q?.correct_choice_text);
  if (!derived) return { status: "consistent" };

  const choices = q?.choices ?? {};
  const matches = Object.keys(choices).filter((l) => normalizeText(choices[l]) === derived);

  // The model computed an answer that isn't among its own options — exactly the
  // "222_3 = 26, so base 3 works" case, where 30 appears nowhere. Unsalvageable.
  if (matches.length === 0) return { status: "wrong", derived };
  if (matches.includes(q.answer)) return { status: "consistent" };
  return { status: "corrected", answer: matches[0] };
}

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
async function generateTopic(env, questionNumber, quantity, reasoning) {
  const bank = BANKS[questionNumber];
  const examples = sampleExamples(bank.questions, MAX_EXAMPLES).map(toExample);

  // Not every topic is "trace this snippet". Topic 1 (number bases) is entirely
  // prose questions whose values live in the choices, and several topics mix
  // both. Forcing a `code` field on those pushes the model to invent one and to
  // mangle the choices into whatever that fake code would print, so tell it
  // plainly which shape this topic actually takes.
  const codeCount = bank.questions.filter((q) => (q.code || "").trim()).length;
  const codeStyle =
    codeCount === 0 ? "none" : codeCount === bank.questions.length ? "all" : "mixed";

  const shapeRules =
    codeStyle === "none"
      ? [
          "- This topic's questions have NO code. Set 'code' to an empty string.",
          "  The question is posed entirely in the stem and the choices.",
        ]
      : codeStyle === "mixed"
        ? [
            "- Most questions on this topic show a Java 'code' snippet, but some are",
            "  concept questions with no code. Follow the examples: if a question needs",
            "  no code, set 'code' to an empty string rather than inventing one.",
            "- When there is code, use '\\n' for newlines; output via out.print / out.println.",
          ]
        : [
            "- Each question shows a Java 'code' snippet the question asks about.",
            "  Use '\\n' for newlines. Output statements use out.print / out.println / out.printf.",
          ];

  const systemPrompt = [
    "You are an author of UIL Computer Science multiple-choice questions for Java.",
    `Every question you write is on the topic: "${bank.topic}".`,
    "You are given existing questions as examples. Write brand-new original questions in the exact same style and difficulty.",
    "Rules:",
    `- Return EXACTLY ${quantity} question${quantity === 1 ? "" : "s"} — no more, no fewer.`,
    "- Each question needs a stem, five choices A-E, one correct 'answer', and an 'explanation'.",
    ...shapeRules,
    "- Exactly one of the five choices must be correct. Make the other four plausible distractors.",
    "- The five choices must be FIVE DISTINCT values. Never repeat a value across two letters.",
    "- Distractors must be wrong. Never include a second choice that is also correct.",
    "- Do NOT copy the example questions. Change the values and structure so each question is genuinely new.",
    "- Keep 'explanation' brief.",
    "",
    "NOTATION: write the choices in the same notation the stem asks about, and",
    "match the notation used in the examples. If the question compares numbers in",
    "different bases, the choices must stay in those bases (e.g. 1101_2, 23_4,",
    "1B_(16)) — never replace them with their decimal values, or the question",
    "loses its point and becomes trivial.",
    "",
    "Work in this exact order for every question. Do not skip ahead:",
    "  1. 'code'   — the Java snippet, or an empty string if this topic has none.",
    "  2. 'work'   — derive the answer step by step. For code, trace it exactly as",
    "                the JVM would and be pedantic about: integer division",
    "                truncating toward zero, operator precedence, % keeping the",
    "                sign of the dividend, int overflow wrapping at 32 bits,",
    "                int-vs-double promotion, and println adding a newline.",
    "                For concept questions, show the conversion/derivation for",
    "                EVERY choice, not just the one you think is right.",
    "                Slow down here — this is where mistakes happen.",
    "  3. 'correct_choice_text' — the exact text of the correct choice, taken",
    "                straight from 'work', in the question's own notation.",
    "  4. 'choices'— put 'correct_choice_text' verbatim into one of A-E. Fill the",
    "                other four with DISTINCT wrong values (plausible near-misses).",
    "  5. 'answer' — the letter you just placed it into. It must satisfy",
    "                choices[answer] === correct_choice_text, character for character.",
    "  6. 'explanation' — restate the reasoning from 'work' concisely.",
    "",
    "CRITICAL: 'answer' is decided by where you put 'correct_choice_text', never",
    "by guessing. Before returning, re-read your 'work': if it arrives at a value",
    "different from choices[answer], the question is WRONG — fix it. If no choice",
    "is actually correct, rewrite the choices.",
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
    ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
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
  //   unverifiable -> fall back to the model's own self-consistency check
  const questions = [];
  let confirmed = 0;
  let corrected = 0;
  let dropped = 0;
  let unverified = 0;

  // `work` is scratch space the model needed in order to reason before
  // answering; it isn't part of the question, so keep it out of the response.
  // `correct_choice_text` is kept — it's small and useful for debugging a
  // disputed answer.
  const present = ({ work, ...rest }) => rest;

  for (const q of rawQuestions) {
    const result = verifyQuestion(q);
    if (result.status === "ok") {
      confirmed++;
      questions.push({ ...present(q), verified: true });
    } else if (result.status === "corrected") {
      corrected++;
      questions.push({ ...present(q), answer: result.answer, verified: true });
    } else if (result.status === "wrong") {
      // The model produced choices none of which equal the real output.
      // There's nothing to salvage, so omit it from the response.
      dropped++;
    } else {
      // The evaluator can't run this code (loops, arrays, Scanner, ArrayList).
      // Fall back to the model's own declared `output`: it derived that from its
      // step-by-step trace before choosing a letter, so if it disagrees with
      // choices[answer] the question contradicts itself. That's the "wrong
      // letter, right explanation" failure, and we can catch it here without
      // executing any Java.
      const selfCheck = reconcileWithSelfReport(q);
      if (selfCheck.status === "corrected") {
        corrected++;
        questions.push({ ...present(q), answer: selfCheck.answer, verified: false, self_corrected: true });
      } else if (selfCheck.status === "wrong") {
        dropped++;
      } else {
        unverified++;
        questions.push({ ...present(q), verified: false });
      }
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
function streamJobs(env, jobs, reasoning) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      await forEachWithConcurrency(
        jobs,
        ALL_CONCURRENCY,
        (job) => generateTopic(env, job.topic, job.quantity, reasoning),
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

    // Optional extra thinking budget, e.g. ?reasoning=medium. Off by default:
    // see REASONING_EFFORTS for why.
    const reasoning = url.searchParams.get("reasoning");
    if (reasoning !== null && !REASONING_EFFORTS.includes(reasoning)) {
      return badRequest(`'reasoning' must be one of: ${REASONING_EFFORTS.join(", ")}.`);
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
      return streamJobs(env, jobs, reasoning);
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
      return streamJobs(env, jobs, reasoning);
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

    const result = await generateTopic(env, question, quantity, reasoning);
    const status = result.error ? 502 : 200;
    return Response.json(result, { status });
  },
};
