// Runtime-agnostic core: handleMove(body, env) -> { status, body }.
// Modes:
//   player   code does perception + forced tactics; Jev chooses among ranked, annotated candidates
//   assisted every empty point is an option, annotated with exact line facts; Jev decides everything
//   naked    every empty point is an option with no description; Jev decides everything (measurement)

import * as G from "./gomoku.js";

const NATIVE_URL = "https://api.typesafe.ai/v1/systemone";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate";
const RULES =
  "Gomoku on a 15x15 board. Five in a row wins. X is black, O is white, . is empty. " +
  "Coordinates are column letter A-O then row number 1-15.";
export const MODES = ["player", "assisted", "naked"];

export function backend(env = {}) {
  if (env.TYPESAFE_API_KEY) return { kind: "native", key: env.TYPESAFE_API_KEY };
  if (env.AI_GATEWAY_API_KEY) return { kind: "gateway", key: env.AI_GATEWAY_API_KEY };
  return { kind: "mock" };
}
const modelFor = (be) => (be.kind === "native" ? "jev-latest" : be.kind === "gateway" ? "typesafe-ai/jev" : "mock-heuristic");

function baseState(board, moves, me) {
  return { game: RULES, you_are: me, to_move: me, board: G.render(board).split("\n"), recent_moves: moves.slice(-12) };
}

// naked / assisted: every empty point, three questions.
export function buildFullRequest(board, moves, me, opp, mode, nullOk = true) {
  const criteria = {};
  for (const p of G.emptyPoints(board)) {
    criteria[p.key] = mode === "assisted" ? G.describe(board, p.r, p.c, me, opp) : nullOk ? null : p.key;
  }
  const withNone = { none: "No such point exists.", ...criteria };
  const questions = {
    win_now: {
      type: "choice",
      instructions: `The empty point where placing ${me} makes five ${me} stones in a row. Choose none if no single ${me} move does this.`,
      criteria: withNone,
    },
    must_block: {
      type: "choice",
      instructions:
        `The empty point where ${opp} would make five in a row, or an open four, on ${opp}'s next move ` +
        `if ${me} does not occupy it now. Choose none if ${opp} has no such threat.`,
      criteria: withNone,
    },
    best_move: { type: "choice", instructions: `The strongest move for ${me} in this position to win the game.`, criteria },
  };
  return { state: baseState(board, moves, me), questions, legal: new Set(Object.keys(criteria)) };
}

function threatSummary(cands, me, opp) {
  const pick = (side, classes) => cands.all.filter((c) => classes.includes(c[side].cls)).map((c) => c.key).slice(0, 6);
  const s = {};
  const add = (k, v) => { if (v.length) s[k] = v; };
  add(`${opp}_can_make_open_four_at`, pick("opp", ["open_four"]));
  add(`${opp}_can_make_four_at`, pick("opp", ["four", "four_three", "double_four"]));
  add(`${opp}_can_make_open_three_at`, pick("opp", ["open_three", "double_three"]));
  add(`${me}_can_make_four_at`, pick("me", ["four", "four_three", "double_four"]));
  add(`${me}_can_make_open_three_at`, pick("me", ["open_three", "double_three"]));
  return s;
}

// player: code decides forced tactics; otherwise a ranked candidate pool for Jev.
export function playerPlan(board, me, opp, max = 12) {
  const winPts = G.fivePointsFor(board, me);
  if (winPts.length) return { forced: { move: winPts[0], source: "forced-win", note: null } };
  const oppFive = G.fivePointsFor(board, opp);
  if (oppFive.length)
    return { forced: { move: oppFive[0], source: "forced-block", note: oppFive.length > 1 ? `${opp} has ${oppFive.length} winning points; blocking one` : null } };
  const cands = G.candidates(board, me, opp, max);
  const of = cands.all.find((c) => c.me.cls === "open_four");
  if (of) return { forced: { move: of.key, source: "open-four", note: null }, cands };
  const oppThreatens = cands.all.some((c) => c.opp.cls === "open_four");
  let pool = cands.top;
  if (oppThreatens) {
    const safe = cands.all.filter((c) => c.danger !== "open_four" || c.forcing);
    if (safe.length) pool = safe.slice(0, max);
  }
  return { pool, cands, oppThreatens };
}

export function buildPlayerRequest(board, moves, me, opp, plan) {
  const criteria = {};
  for (const c of plan.pool) criteria[c.key] = c.desc;
  const state = { ...baseState(board, moves, me), threats: threatSummary(plan.cands, me, opp) };
  const questions = {
    best_move: {
      type: "choice",
      instructions:
        `The strongest move for ${me}. Each option states exactly what ${me}'s stone would create ` +
        `and what ${opp} threat it would block, computed from the board.`,
      criteria,
    },
  };
  return { state, questions, legal: new Set(Object.keys(criteria)) };
}

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

// Heuristic stand-in when no key is configured. Imperfect on purpose, so the UI shows misses too.
export function mockAnswers(board, me, opp, legal, truth, rng = Math.random, questions = null) {
  const pts = G.emptyPoints(board).filter((p) => legal.has(p.key));
  const scores = pts.map((p) => {
    const m = G.lineInfo(board, p.r, p.c, me), o = G.lineInfo(board, p.r, p.c, opp);
    const s =
      Math.max(...m.map((l) => l.len * (l.open ? 1.6 : 1))) +
      0.85 * Math.max(...o.map((l) => l.len * (l.open ? 1.6 : 1))) +
      rng() * 0.6;
    return [p.key, s];
  });
  const max = Math.max(...scores.map((s) => s[1]));
  const exps = scores.map(([k, s]) => [k, Math.exp((s - max) * 1.8)]);
  const z = exps.reduce((a, [, v]) => a + v, 0);
  const best = Object.fromEntries(exps.map(([k, v]) => [k, v / z]));
  const out = { best_move: { type: "choice", choice: G.argmax(best), probabilities: best } };
  if (!questions || questions.win_now) {
    const peaked = (choice) => {
      const probs = {};
      for (const k of legal) probs[k] = 0.1 / legal.size;
      probs.none = 0.1 / (legal.size + 1);
      probs[choice] = 0.9;
      return { type: "choice", choice, probabilities: probs };
    };
    const pick = (arr, hitRate) => (arr.length && rng() < hitRate ? arr[Math.floor(rng() * arr.length)] : "none");
    out.win_now = peaked(pick(truth.win, 0.85));
    out.must_block = peaked(pick(truth.block, 0.7));
  }
  return out;
}

function readAnswer(a) {
  const probs = (a && a.probabilities) || {};
  const choice = (a && a.choice) ?? G.argmax(probs);
  const conf = a && typeof a.confidence === "number" ? a.confidence : G.confidenceFrom(probs);
  return { choice, conf, top: G.topK(probs, 5) };
}
function verdict(claim, truthArr) {
  const set = new Set(truthArr);
  if (set.size === 0) return claim === "none" ? "correct_none" : "false";
  if (set.has(claim)) return "found";
  return claim === "none" ? "missed" : "false";
}
// naked/assisted priority: verified win, else verified block, else best_move. A wrong claim falls through.
export function decide(answers, truth, legal) {
  const win = readAnswer(answers.win_now);
  const block = readAnswer(answers.must_block);
  const best = readAnswer(answers.best_move);
  const v = { win: verdict(win.choice, truth.win), block: verdict(block.choice, truth.block) };
  let move, source;
  if (win.choice !== "none" && truth.win.includes(win.choice)) { move = win.choice; source = "win"; }
  else if (block.choice !== "none" && truth.block.includes(block.choice)) { move = block.choice; source = "block"; }
  else if (legal.has(best.choice)) { move = best.choice; source = "best"; }
  else { move = [...legal][0]; source = "fallback"; }
  return { move, source, verdict: v, win, block, best };
}

const pack = (a) => ({ choice: a.choice, confidence: Number(a.conf.toFixed(3)), top: a.top.map(([k, v]) => [k, Number(v.toFixed(4))]) });
const reply = (status, body) => ({ status, body });
export function normalizeMode(mode, assist) {
  if (MODES.includes(mode)) return mode;
  if (assist === true) return "assisted";
  if (assist === false) return "naked";
  return "player";
}

async function ask(be, board, me, opp, legal, truth, state, questions) {
  const payload = { model: modelFor(be), state, questions };
  const t0 = Date.now();
  let answers, usage = null, model = payload.model, raw;
  if (be.kind === "mock") {
    answers = mockAnswers(board, me, opp, legal, truth, Math.random, questions);
    await new Promise((r) => setTimeout(r, 60));
    raw = { model, answers, usage: null, note: "mock backend: no API call was made" };
  } else {
    ({ answers, usage, model, raw } = await callJev(be, payload));
  }
  return { answers, usage, model, latencyMs: Date.now() - t0, io: { request: payload, response: raw } };
}

export async function handleMove(body, env = {}) {
  try {
    const { board: rows, moves = [], humanMove = null, jev = "O" } = body || {};
    const mode = normalizeMode(body && body.mode, body && body.assist);
    if (jev !== "X" && jev !== "O") throw new Error("jev must be X or O");
    if (!Array.isArray(moves)) throw new Error("moves must be an array");
    const me = jev, opp = jev === "X" ? "O" : "X";
    const board = G.parseBoard(rows);
    const mv = moves.slice();
    const be = backend(env);
    const done = (status, jevInfo) => reply(200, { ok: true, board: G.toRows(board), moves: mv, status, backend: be.kind, mode, jev: jevInfo });

    if (humanMove) {
      if (G.toMove(board) !== opp) throw new Error("not the human's turn");
      const p = G.fromKey(humanMove);
      if (!p || board[p.r][p.c] !== ".") throw new Error("illegal human move");
      board[p.r][p.c] = opp;
      mv.push(`${opp} ${humanMove}`);
      if (G.isWinAt(board, p.r, p.c)) return done("human_wins", null);
      if (G.emptyPoints(board).length === 0) return done("draw", null);
    }
    if (G.toMove(board) !== me) throw new Error("not Jev's turn");

    const truth = G.threatSets(board, me, opp);
    let info;
    if (mode === "player") {
      const plan = playerPlan(board, me, opp);
      const slim = (c, i) => ({ key: c.key, desc: c.desc, score: Math.round(c.score), rank: i + 1 });
      if (plan.forced) {
        info = {
          move: plan.forced.move, source: plan.forced.source, note: plan.forced.note, mode,
          latencyMs: 0, usage: null, model: null, optionCount: 0, truth, verdict: null, answers: null,
          candidates: plan.cands ? plan.cands.top.map(slim) : [], heuristicRank: null, io: null,
        };
      } else {
        const { state, questions, legal } = buildPlayerRequest(board, mv, me, opp, plan);
        const r = await ask(be, board, me, opp, legal, truth, state, questions);
        const best = readAnswer(r.answers.best_move);
        const move = legal.has(best.choice) ? best.choice : plan.pool[0].key;
        info = {
          move, source: legal.has(best.choice) ? "best" : "fallback", note: plan.oppThreatens ? `${opp} threatens an open four; pool restricted to answers` : null, mode,
          latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size, truth, verdict: null,
          answers: { best_move: pack(best) },
          candidates: plan.pool.map(slim), heuristicRank: plan.cands.all.findIndex((c) => c.key === move) + 1, io: r.io,
        };
      }
    } else {
      const { state, questions, legal } = buildFullRequest(board, mv, me, opp, mode, be.kind !== "gateway");
      const r = await ask(be, board, me, opp, legal, truth, state, questions);
      const d = decide(r.answers, truth, legal);
      info = {
        move: d.move, source: d.source, note: null, mode,
        latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size, truth, verdict: d.verdict,
        answers: { win_now: pack(d.win), must_block: pack(d.block), best_move: pack(d.best) },
        candidates: [], heuristicRank: null, io: r.io,
      };
    }

    const p = G.fromKey(info.move);
    board[p.r][p.c] = me;
    mv.push(`${me} ${info.move}`);
    let status = "playing";
    if (G.isWinAt(board, p.r, p.c)) status = "jev_wins";
    else if (G.emptyPoints(board).length === 0) status = "draw";
    return done(status, info);
  } catch (e) {
    return reply(e.status || 400, { ok: false, error: String(e.message || e) });
  }
}
