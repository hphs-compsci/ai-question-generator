// Verifies generated Java questions by independently evaluating the code with
// Java semantics, so a question's stated answer can be checked (and corrected)
// instead of trusted. It handles expression-style topics: literal math, mixed
// int/double arithmetic, boolean logic, bitwise ops, string methods, casts,
// hex/binary literals, and the common Math / Integer static methods, plus simple
// `type name = expr;` declarations feeding a single output statement.
//
// It deliberately does NOT model control flow (loops, if/switch), arrays,
// Scanner, or ArrayList. Anything it can't parse returns { status:
// "unverifiable" } and the caller decides what to do (we flag, not drop).
//
// Java semantics that matter here:
//   - int arithmetic wraps at 32 bits (JS bit ops give us this for free).
//   - integer division truncates toward zero (JS `/` does not).
//   - `%` takes the sign of the dividend (trunc-based, matches Java for ints).
//   - a `.` in a literal or a `double` operand promotes the result to double.
//   - `+` is string concatenation if either operand is a String.

const INT = "int";
const DOUBLE = "double";
const BOOL = "boolean";
const STRING = "String";

// A value carries both its payload and its Java type, since the type drives
// whether `/` truncates, whether `+` concatenates, and how it prints.
function val(type, value) {
  return { type, value };
}

class UnsupportedError extends Error {}

// --- Tokenizer -------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const twoChar = ["<<", ">>", "&&", "||", "==", "!=", "<=", ">="];
  const threeChar = [">>>"];
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // String literal. No escape handling beyond the common \n \t \" \\.
    if (c === '"') {
      let j = i + 1;
      let str = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1];
          str += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
          j += 2;
          continue;
        }
        str += src[j];
        j++;
      }
      if (j >= src.length) throw new UnsupportedError("unterminated string literal");
      tokens.push({ kind: "str", value: str });
      i = j + 1;
      continue;
    }
    // char literal 'x' — treated as its int code only where used numerically.
    if (c === "'") {
      let j = i + 1;
      let ch;
      if (src[j] === "\\") {
        const esc = src[j + 1];
        ch = esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
        j += 2;
      } else {
        ch = src[j];
        j += 1;
      }
      if (src[j] !== "'") throw new UnsupportedError("bad char literal");
      tokens.push({ kind: "char", value: ch });
      i = j + 1;
      continue;
    }
    // Numeric literal: decimal, 0x hex, 0b binary, with optional d/f/L suffix.
    if (c >= "0" && c <= "9") {
      let j = i;
      let type = INT;
      let value;
      if (src[j] === "0" && (src[j + 1] === "x" || src[j + 1] === "X")) {
        j += 2;
        const start = j;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
        value = parseInt(src.slice(start, j), 16);
      } else if (src[j] === "0" && (src[j + 1] === "b" || src[j + 1] === "B")) {
        j += 2;
        const start = j;
        while (j < src.length && /[01]/.test(src[j])) j++;
        value = parseInt(src.slice(start, j), 2);
      } else {
        let isDouble = false;
        while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) {
          if (src[j] === ".") isDouble = true;
          j++;
        }
        let suffix = "";
        if (j < src.length && "dDfFlL".includes(src[j])) {
          suffix = src[j];
          j++;
        }
        if (suffix && "dDfF".includes(suffix)) isDouble = true;
        value = Number(src.slice(i, j).replace(/[dDfFlL]$/, ""));
        type = isDouble ? DOUBLE : INT;
      }
      tokens.push({ kind: "num", value, type });
      i = j;
      continue;
    }
    // Identifier / keyword.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      tokens.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (threeChar.includes(three)) {
      tokens.push({ kind: "op", value: three });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (twoChar.includes(two)) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if ((c === "+" && src[i + 1] === "+") || (c === "-" && src[i + 1] === "-")) {
      throw new UnsupportedError("increment/decrement not supported");
    }
    if ("+-*/%&|^~!<>().,".includes(c)) {
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    throw new UnsupportedError(`unexpected character '${c}'`);
  }
  return tokens;
}

// --- Parser / evaluator ----------------------------------------------------

const BINARY_PRECEDENCE = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  "<<": 8,
  ">>": 8,
  ">>>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
};

function evaluate(src, env) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (t, v) => t && t.kind === "op" && t.value === v;

  function parseExpression(minPrec) {
    let left = parseUnary();
    while (true) {
      const t = peek();
      if (!t || t.kind !== "op" || !(t.value in BINARY_PRECEDENCE)) break;
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec < minPrec) break;
      next();
      const right = parseExpression(prec + 1);
      left = applyBinary(t.value, left, right);
    }
    return left;
  }

  function parseUnary() {
    const t = peek();
    // Cast: (int)expr / (double)expr. Distinguished from a parenthesized
    // expression by a type keyword immediately inside the parens.
    if (isOp(t, "(")) {
      const nt = tokens[pos + 1];
      const isCast =
        nt && nt.kind === "ident" && ["int", "double", "long"].includes(nt.value) && isOp(tokens[pos + 2], ")");
      if (isCast) {
        next(); // (
        const castType = next().value; // int|double|long
        next(); // )
        const operand = parseUnary();
        return applyCast(castType, operand);
      }
    }
    if (t && t.kind === "op" && (t.value === "-" || t.value === "+" || t.value === "!" || t.value === "~")) {
      next();
      const operand = parseUnary();
      return applyUnary(t.value, operand);
    }
    return parsePostfix(parsePrimary());
  }

  // Handle chained `.method(args)` / `.field` after a primary, e.g.
  // str.substring(1,3).toUpperCase().length()
  function parsePostfix(base) {
    let value = base;
    while (isOp(peek(), ".")) {
      next(); // .
      const nameTok = next();
      if (!nameTok || nameTok.kind !== "ident") throw new UnsupportedError("expected member name");
      const member = nameTok.value;
      if (isOp(peek(), "(")) {
        const args = parseArgs();
        value = applyMethod(value, member, args);
      } else {
        // Bare field access like `.length` on arrays isn't supported.
        throw new UnsupportedError(`unsupported field .${member}`);
      }
    }
    return value;
  }

  function parseArgs() {
    next(); // (
    const args = [];
    if (!isOp(peek(), ")")) {
      args.push(parseExpression(1));
      while (isOp(peek(), ",")) {
        next();
        args.push(parseExpression(1));
      }
    }
    if (!isOp(peek(), ")")) throw new UnsupportedError("missing ')' in call");
    next(); // )
    return args;
  }

  function parsePrimary() {
    const t = next();
    if (!t) throw new UnsupportedError("unexpected end of expression");
    if (t.kind === "num") return val(t.type, t.value);
    if (t.kind === "str") return val(STRING, t.value);
    if (t.kind === "char") return val(INT, t.value.charCodeAt(0));
    if (t.kind === "ident") {
      if (t.value === "true") return val(BOOL, true);
      if (t.value === "false") return val(BOOL, false);
      // Static call like Math.pow(...) / Integer.parseInt(...).
      if ((t.value === "Math" || t.value === "Integer" || t.value === "Double") && isOp(peek(), ".")) {
        next(); // .
        const method = next();
        if (!method || method.kind !== "ident") throw new UnsupportedError("bad static call");
        const args = parseArgs();
        return applyStatic(t.value, method.value, args);
      }
      if (Object.prototype.hasOwnProperty.call(env, t.value)) return env[t.value];
      throw new UnsupportedError(`unknown identifier '${t.value}'`);
    }
    if (isOp(t, "(")) {
      const inner = parseExpression(1);
      if (!isOp(peek(), ")")) throw new UnsupportedError("missing ')'");
      next();
      return inner;
    }
    throw new UnsupportedError(`unexpected token '${t.value}'`);
  }

  const result = parseExpression(1);
  if (pos !== tokens.length) throw new UnsupportedError("trailing tokens");
  return result;
}

function toInt32(n) {
  return n | 0;
}

function applyCast(castType, operand) {
  if (castType === "int" || castType === "long") {
    if (operand.type === STRING || operand.type === BOOL) throw new UnsupportedError("bad cast");
    return val(INT, toInt32(Math.trunc(operand.value)));
  }
  // (double)
  if (operand.type === STRING || operand.type === BOOL) throw new UnsupportedError("bad cast");
  return val(DOUBLE, operand.value);
}

function applyUnary(op, operand) {
  if (op === "+") return operand;
  if (op === "-") {
    if (operand.type === DOUBLE) return val(DOUBLE, -operand.value);
    return val(INT, toInt32(-operand.value));
  }
  if (op === "~") {
    if (operand.type !== INT) throw new UnsupportedError("~ on non-int");
    return val(INT, ~operand.value);
  }
  if (op === "!") {
    if (operand.type !== BOOL) throw new UnsupportedError("! on non-boolean");
    return val(BOOL, !operand.value);
  }
  throw new UnsupportedError(`unary ${op}`);
}

function applyBinary(op, a, b) {
  switch (op) {
    case "&&":
      return val(BOOL, a.value && b.value);
    case "||":
      return val(BOOL, a.value || b.value);
    case "==":
      return val(BOOL, a.value === b.value);
    case "!=":
      return val(BOOL, a.value !== b.value);
    case "<":
      return val(BOOL, a.value < b.value);
    case ">":
      return val(BOOL, a.value > b.value);
    case "<=":
      return val(BOOL, a.value <= b.value);
    case ">=":
      return val(BOOL, a.value >= b.value);
    default:
      break;
  }

  // `+` with a String operand is concatenation (the other side is rendered the
  // Java way, e.g. a whole double becomes "7.0").
  if (op === "+" && (a.type === STRING || b.type === STRING)) {
    return val(STRING, formatJava(a) + formatJava(b));
  }

  if (op === "&" || op === "|" || op === "^") {
    if (a.type === BOOL && b.type === BOOL) {
      const r = op === "&" ? a.value && b.value : op === "|" ? a.value || b.value : a.value !== b.value;
      return val(BOOL, r);
    }
    requireInts(op, a, b);
    const r = op === "&" ? a.value & b.value : op === "|" ? a.value | b.value : a.value ^ b.value;
    return val(INT, r);
  }
  if (op === "<<" || op === ">>" || op === ">>>") {
    requireInts(op, a, b);
    const r = op === "<<" ? a.value << b.value : op === ">>" ? a.value >> b.value : a.value >>> b.value;
    return val(INT, toInt32(r));
  }

  requireNumeric(op, a, b);
  const isDouble = a.type === DOUBLE || b.type === DOUBLE;
  switch (op) {
    case "+":
      return num(isDouble, a.value + b.value);
    case "-":
      return num(isDouble, a.value - b.value);
    case "*":
      return isDouble ? val(DOUBLE, a.value * b.value) : val(INT, Math.imul(a.value, b.value));
    case "/":
      if (isDouble) return val(DOUBLE, a.value / b.value);
      if (b.value === 0) throw new UnsupportedError("integer division by zero");
      return val(INT, toInt32(Math.trunc(a.value / b.value)));
    case "%":
      if (isDouble) return val(DOUBLE, a.value % b.value);
      if (b.value === 0) throw new UnsupportedError("integer modulo by zero");
      return val(INT, a.value % b.value);
    default:
      throw new UnsupportedError(`binary ${op}`);
  }
}

// --- String instance methods ----------------------------------------------

function applyMethod(recv, name, args) {
  if (recv.type !== STRING) throw new UnsupportedError(`method .${name} on ${recv.type}`);
  const s = recv.value;
  const a = args.map((x) => x.value);
  switch (name) {
    case "length":
      return val(INT, s.length);
    case "substring":
      // Java substring throws on out-of-range; treat that as unverifiable
      // rather than silently returning JS's clamped result.
      if (args.length === 1) {
        if (a[0] < 0 || a[0] > s.length) throw new UnsupportedError("substring out of range");
        return val(STRING, s.substring(a[0]));
      }
      if (a[0] < 0 || a[1] > s.length || a[0] > a[1]) throw new UnsupportedError("substring out of range");
      return val(STRING, s.substring(a[0], a[1]));
    case "charAt":
      if (a[0] < 0 || a[0] >= s.length) throw new UnsupportedError("charAt out of range");
      return val(STRING, s.charAt(a[0])); // Java prints a char, matches a 1-char string
    case "toUpperCase":
      return val(STRING, s.toUpperCase());
    case "toLowerCase":
      return val(STRING, s.toLowerCase());
    case "trim":
      return val(STRING, s.trim());
    case "indexOf": {
      // Arg may be a String or a char (int code); optional fromIndex.
      const needle = typeof a[0] === "string" ? a[0] : String.fromCharCode(a[0]);
      return val(INT, args.length > 1 ? s.indexOf(needle, a[1]) : s.indexOf(needle));
    }
    case "equals":
      return val(BOOL, s === args[0].value);
    case "equalsIgnoreCase":
      return val(BOOL, s.toLowerCase() === String(args[0].value).toLowerCase());
    case "replace": {
      // replace(char, char): args arrive as int char-codes; render back to
      // chars. replace(CharSequence, CharSequence): args are strings.
      const from = typeof a[0] === "number" ? String.fromCharCode(a[0]) : a[0];
      const to = typeof a[1] === "number" ? String.fromCharCode(a[1]) : a[1];
      return val(STRING, s.split(from).join(to));
    }
    case "concat":
      return val(STRING, s + args[0].value);
    default:
      throw new UnsupportedError(`unsupported string method .${name}`);
  }
}

// --- Static methods (Math / Integer / Double) ------------------------------

function applyStatic(cls, name, args) {
  const a = args.map((x) => x.value);
  if (cls === "Math") {
    switch (name) {
      // These return a double in Java.
      case "pow":
        return val(DOUBLE, Math.pow(a[0], a[1]));
      case "sqrt":
        return val(DOUBLE, Math.sqrt(a[0]));
      case "cbrt":
        return val(DOUBLE, Math.cbrt(a[0]));
      case "floor":
        return val(DOUBLE, Math.floor(a[0]));
      case "ceil":
        return val(DOUBLE, Math.ceil(a[0]));
      // round(double)->long (int here); round(float)->int.
      case "round":
        return val(INT, Math.round(a[0]));
      // abs/max/min preserve int-ness if all args are ints.
      case "abs": {
        const t = args[0].type === DOUBLE ? DOUBLE : INT;
        return val(t, Math.abs(a[0]));
      }
      case "max": {
        const t = args.some((x) => x.type === DOUBLE) ? DOUBLE : INT;
        return val(t, Math.max(a[0], a[1]));
      }
      case "min": {
        const t = args.some((x) => x.type === DOUBLE) ? DOUBLE : INT;
        return val(t, Math.min(a[0], a[1]));
      }
      default:
        throw new UnsupportedError(`unsupported Math.${name}`);
    }
  }
  if (cls === "Integer") {
    switch (name) {
      case "parseInt":
        return val(INT, toInt32(parseInt(String(a[0]), a[1] ?? 10)));
      case "toBinaryString":
        return val(STRING, (a[0] >>> 0).toString(2));
      case "toHexString":
        return val(STRING, (a[0] >>> 0).toString(16));
      case "toString":
        return val(STRING, a.length > 1 ? a[0].toString(a[1]) : String(a[0]));
      case "max":
        return val(INT, Math.max(a[0], a[1]));
      case "min":
        return val(INT, Math.min(a[0], a[1]));
      default:
        throw new UnsupportedError(`unsupported Integer.${name}`);
    }
  }
  if (cls === "Double") {
    if (name === "parseDouble") return val(DOUBLE, Number(a[0]));
    throw new UnsupportedError(`unsupported Double.${name}`);
  }
  throw new UnsupportedError(`unsupported static ${cls}.${name}`);
}

function num(isDouble, value) {
  return isDouble ? val(DOUBLE, value) : val(INT, toInt32(value));
}

function requireInts(op, a, b) {
  if (a.type !== INT || b.type !== INT) throw new UnsupportedError(`${op} requires int operands`);
}

function requireNumeric(op, a, b) {
  if (a.type === STRING || b.type === STRING || a.type === BOOL || b.type === BOOL) {
    throw new UnsupportedError(`${op} requires numeric operands`);
  }
}

// --- Statement handling ----------------------------------------------------

const OUTPUT_RE = /out\s*\.\s*print(?:ln)?\s*\(([\s\S]*)\)\s*;?\s*$/;
const DECL_RE = /^\s*(?:final\s+)?(int|double|boolean|long|String)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+?)\s*;?\s*$/;

// Split on ';', but not inside string literals (which can contain ';').
function splitStatements(code) {
  const parts = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' && code[i - 1] !== "\\") inStr = !inStr;
    if (c === ";" && !inStr) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Format a computed value the way Java's print/println renders it.
function formatJava(v) {
  if (v.type === BOOL) return String(v.value);
  if (v.type === STRING) return v.value;
  if (v.type === DOUBLE) {
    if (!Number.isFinite(v.value)) {
      if (Number.isNaN(v.value)) return "NaN";
      return v.value > 0 ? "Infinity" : "-Infinity";
    }
    if (Number.isInteger(v.value)) return v.value.toFixed(1);
    return String(v.value);
  }
  return String(v.value);
}

// Control-flow / declaration keywords the evaluator can't model. If any appears
// (as a whole word) we bail out entirely rather than risk mis-evaluating by
// treating a loop/branch body as a plain sequence of statements.
const UNSUPPORTED_KEYWORDS =
  /\b(if|else|for|while|do|switch|case|return|new|class|void)\b/;

function evaluateSnippet(code) {
  if (UNSUPPORTED_KEYWORDS.test(code)) {
    throw new UnsupportedError("control flow / unsupported construct");
  }
  const statements = splitStatements(code);
  const env = {};
  const outputs = [];

  for (const stmt of statements) {
    const outMatch = stmt.match(OUTPUT_RE);
    if (outMatch) {
      outputs.push(formatJava(evaluate(outMatch[1], env)));
      // println appends a newline; print does not. Preserve it so multi-line
      // output is represented faithfully (comparison normalizes newlines).
      if (/print\s*ln/.test(stmt)) outputs.push("\n");
      continue;
    }
    const declMatch = stmt.match(DECL_RE);
    if (declMatch) {
      const declType = declMatch[1] === "long" ? INT : declMatch[1];
      const name = declMatch[2];
      const value = evaluate(declMatch[3], env);
      if (declType === DOUBLE && value.type === INT) {
        env[name] = val(DOUBLE, value.value);
      } else {
        env[name] = val(value.type, value.value);
      }
      continue;
    }
    // Bare assignment to an existing variable: name = expr;
    const assignMatch = stmt.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/);
    if (assignMatch && Object.prototype.hasOwnProperty.call(env, assignMatch[1])) {
      const cur = env[assignMatch[1]];
      const value = evaluate(assignMatch[2], env);
      env[assignMatch[1]] = cur.type === DOUBLE && value.type === INT ? val(DOUBLE, value.value) : value;
      continue;
    }
    throw new UnsupportedError(`unsupported statement: ${stmt}`);
  }

  if (outputs.filter((o) => o !== "\n").length === 0) {
    throw new UnsupportedError("no output statement");
  }
  return outputs.join("").replace(/\n$/, "");
}

// --- Public API ------------------------------------------------------------

// Structural problems that make a question invalid no matter what the code
// evaluates to. Checked for every question, including ones whose code the
// evaluator can't run — a duplicated choice is broken either way.
// Returns a reason string, or null if the question is structurally sound.
export function findStructuralProblem(q) {
  const choices = q?.choices;
  if (!choices || typeof choices !== "object") return "missing choices";

  const letters = ["A", "B", "C", "D", "E"];
  const missing = letters.filter((l) => typeof choices[l] !== "string" || choices[l].trim() === "");
  if (missing.length) return `missing choice(s): ${missing.join(", ")}`;

  const seen = new Map();
  for (const letter of letters) {
    const key = normalize(choices[letter]);
    if (seen.has(key)) return `duplicate choices ${seen.get(key)} and ${letter} (both "${choices[letter]}")`;
    seen.set(key, letter);
  }

  if (!letters.includes(q.answer)) return `answer '${q.answer}' is not one of A-E`;
  return null;
}

// Verify one generated question. Returns:
//   { status: "ok" }                       stated answer matches the true output
//   { status: "corrected", answer, ... }   another choice matches; answer fixed
//   { status: "wrong", expected|reason }   structurally broken, or no choice matches
//   { status: "unverifiable" }             code is outside the supported subset
export function verifyQuestion(q) {
  // Structural checks first: they apply even when the code can't be evaluated,
  // and a question with duplicate or missing choices is unusable regardless.
  const structural = findStructuralProblem(q);
  if (structural) return { status: "wrong", reason: structural };

  let expected;
  try {
    expected = evaluateSnippet(q.code || "");
  } catch (err) {
    if (err instanceof UnsupportedError) return { status: "unverifiable" };
    return { status: "unverifiable", note: String(err) };
  }

  const choices = q.choices;
  const matches = Object.keys(choices).filter(
    (letter) => normalize(choices[letter]) === normalize(expected),
  );

  if (matches.length === 0) {
    return { status: "wrong", expected };
  }
  if (matches.includes(q.answer)) {
    return { status: "ok", expected };
  }
  return { status: "corrected", answer: matches[0], expected };
}

// Collapse any run of whitespace (including the newlines println produces) to a
// single space and trim. Choice text in the banks renders multi-line output
// with spaces rather than literal newlines, so this lets the two match.
function normalize(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

export const __test = { evaluateSnippet, formatJava };
