// Shared Jev transport: backend selection, one call, raw request/response capture.
const NATIVE_URL = "https://api.typesafe.ai/v1/systemone";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate";

export function backend(env = {}) {
  if (env.TYPESAFE_API_KEY) return { kind: "native", key: env.TYPESAFE_API_KEY };
  if (env.AI_GATEWAY_API_KEY) return { kind: "gateway", key: env.AI_GATEWAY_API_KEY };
  return { kind: "mock" };
}
export const modelFor = (be) => (be.kind === "native" ? "jev-latest" : be.kind === "gateway" ? "typesafe-ai/jev" : "mock-heuristic");

async function callJev(be, payload) {
  const url = be.kind === "native" ? NATIVE_URL : GATEWAY_URL;
  const r = await fetch(url, {
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
    usage: { input: u.input_tokens ?? u.inputTokens ?? null, output: u.output_tokens ?? u.outputTokens ?? null },
    model: data.model || payload.model,
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

// Generic mock: softmax over heuristic scores for best_move; peaked answers for verified-claim questions.
export function mockFromScores(scores, legal, truthByQuestion, rng = Math.random) {
  const entries = Object.entries(scores).filter(([k]) => legal.has(k));
  const max = Math.max(...entries.map(([, s]) => s));
  const exps = entries.map(([k, s]) => [k, Math.exp((s - max) * 0.6)]);
  const z = exps.reduce((a, [, v]) => a + v, 0);
  const best = Object.fromEntries(exps.map(([k, v]) => [k, v / z]));
  const bestChoice = exps.sort((a, b) => b[1] - a[1])[0][0];
  const out = { best_move: { type: "choice", choice: bestChoice, probabilities: best } };
  for (const [q, { truth, hitRate }] of Object.entries(truthByQuestion || {})) {
    const choice = truth.length && rng() < hitRate ? truth[Math.floor(rng() * truth.length)] : "none";
    const probs = {};
    for (const k of legal) probs[k] = 0.1 / legal.size;
    probs.none = 0.1 / (legal.size + 1);
    probs[choice] = 0.9;
    out[q] = { type: "choice", choice, probabilities: probs };
  }
  return out;
}

export function readAnswer(a, topK, confidenceFrom, argmax) {
  const probs = (a && a.probabilities) || {};
  const choice = (a && a.choice) ?? argmax(probs);
  const conf = a && typeof a.confidence === "number" ? a.confidence : confidenceFrom(probs);
  return { choice, conf, top: topK(probs, 5) };
}
export const pack = (a) => ({ choice: a.choice, confidence: Number(a.conf.toFixed(3)), top: a.top.map(([k, v]) => [k, Number(v.toFixed(4))]) });
export function verdict(claim, truthArr) {
  const set = new Set(truthArr);
  if (set.size === 0) return claim === "none" ? "correct_none" : "false";
  if (set.has(claim)) return "found";
  return claim === "none" ? "missed" : "false";
}
