// Shared Jev conventions: backend selection (TypeSafe native or mock), one call, raw request/response capture,
// probability helpers, answer reading, verdicts, and the mock used when no key is set.
const NATIVE_URL = "https://api.typesafe.ai/v1/systemone";

export const MODES = ["player", "assisted", "naked"];
export const normalizeMode = (mode) => (MODES.includes(mode) ? mode : "player");

export function backend(env = {}) {
  if (env.TYPESAFE_API_KEY) return { kind: "native", key: env.TYPESAFE_API_KEY };
  return { kind: "mock" };
}
export const modelFor = (be) => (be.kind === "native" ? "jev-latest" : "mock-heuristic");

// Upstream numbers are the only usage values allowed through; anything else becomes null (never HTML).
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

async function callJev(be, payload) {
  const r = await fetch(NATIVE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${be.key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`${be.kind} upstream ${r.status}: ${text.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  const data = JSON.parse(text);
  const u = data.usage || {};
  return {
    answers: data.answers || {},
    usage: { input: num(u.input_tokens ?? u.inputTokens), output: num(u.output_tokens ?? u.outputTokens) },
    model: typeof data.model === "string" ? data.model : payload.model,
    raw: data,
  };
}

// ask(): one round trip. `mock()` must return an answers object shaped like the API's.
export async function ask(be, state, questions, mock) {
  const payload = { model: modelFor(be), state, questions };
  const t0 = Date.now();
  let answers, usage = null, model = payload.model, raw;
  if (be.kind === "mock") {
    answers = mock();
    await new Promise((r) => setTimeout(r, 60));
    raw = { model, answers, usage: null, note: "mock backend: no API call was made" };
  } else {
    ({ answers, usage, model, raw } = await callJev(be, payload));
  }
  return { answers, usage, model, latencyMs: Date.now() - t0, io: { request: payload, response: raw } };
}

// ---------- probabilities ----------
// TypeSafe's documented shape-based confidence, generalised to N options: (N*pmax - 1) / (N - 1).
export function confidenceFrom(probs) {
  const vals = Object.values(probs || {}).map(Number).filter((v) => !Number.isNaN(v));
  const n = vals.length;
  if (n < 2) return 1;
  const pmax = Math.max(...vals);
  return Math.max(0, Math.min(1, (n * pmax - 1) / (n - 1)));
}
export function topK(probs, k = 5) {
  return Object.entries(probs || {}).map(([key, p]) => [key, Number(p)]).sort((a, b) => b[1] - a[1]).slice(0, k);
}
export const argmax = (probs) => topK(probs, 1)[0]?.[0] ?? null;

export function readAnswer(a) {
  const probs = (a && a.probabilities) || {};
  const choice = (a && typeof a.choice === "string" ? a.choice : null) ?? argmax(probs);
  const conf = choice == null ? 0 : a && typeof a.confidence === "number" ? a.confidence : confidenceFrom(probs);
  return { choice, conf, top: topK(probs, 5) };
}
export const pack = (a) => ({ choice: a.choice, confidence: Number(a.conf.toFixed(3)), top: a.top.map(([k, v]) => [k, Number(v.toFixed(4))]) });

// found / missed / false / correct_none, or no_answer when the upstream omitted the question.
export function verdict(claim, truthArr) {
  if (claim == null) return "no_answer";
  const set = new Set(truthArr);
  if (set.size === 0) return claim === "none" ? "correct_none" : "false";
  if (set.has(claim)) return "found";
  return claim === "none" ? "missed" : "false";
}

// Mock: softmax over heuristic scores for best_move; peaked, normalised answers for verified-claim
// questions (options = legal points except pass, plus none). Imperfect on purpose so misses show.
export function mockFromScores(scores, legal, truthByQuestion, rng = Math.random) {
  const keys = Object.keys(scores).filter((k) => legal.has(k));
  const max = Math.max(...keys.map((k) => scores[k]));
  const exps = keys.map((k) => [k, Math.exp((scores[k] - max) * 0.6)]);
  const z = exps.reduce((a, [, v]) => a + v, 0);
  const best = Object.fromEntries(exps.map(([k, v]) => [k, v / z]));
  const out = { best_move: { type: "choice", choice: argmax(best), probabilities: best } };
  for (const [q, { truth, hitRate }] of Object.entries(truthByQuestion || {})) {
    const options = keys.filter((k) => k !== "pass").concat("none");
    const choice = truth.length && rng() < hitRate ? truth[Math.floor(rng() * truth.length)] : "none";
    const probs = {};
    for (const k of options) probs[k] = options.length === 1 ? 1 : k === choice ? 0.9 : 0.1 / (options.length - 1);
    out[q] = { type: "choice", choice, probabilities: probs };
  }
  return out;
}
