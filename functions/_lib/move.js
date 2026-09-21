// Runtime-agnostic core: handleMove(body, env) -> { status, body }.
// Used by the Cloudflare Pages Function (functions/api/move.js), the Node dev server, and the tests.

import * as G from "./gomoku.js";

const NATIVE_URL = "https://api.typesafe.ai/v1/systemone";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/evaluate";

export function backend(env = {}) {
  if (env.TYPESAFE_API_KEY) return { kind: "native", key: env.TYPESAFE_API_KEY };
  if (env.AI_GATEWAY_API_KEY) return { kind: "gateway", key: env.AI_GATEWAY_API_KEY };
  return { kind: "mock" };
}

// Every empty point becomes one Choice option. Nothing is hand-picked.
export function buildRequest(board, moves, me, opp, assist) {
  const criteria = {};
  for (const p of G.emptyPoints(board)) {
    criteria[p.key] = assist
      ? G.describe(board, p.r, p.c, me, opp)
      : `column ${p.key[0]}, row ${p.key.slice(1)}`;
  }
  const withNone = { none: "No such point exists.", ...criteria };
  const state = {
    game:
      "Gomoku on a 15x15 board. Five in a row wins. X is black, O is white, . is empty. " +
      "Coordinates are column letter A-O then row number 1-15.",
    you_are: me,
    to_move: me,
    board: G.render(board).split("\n"),
    recent_moves: moves.slice(-12),
  };
  const questions = {
    win_now: {
      type: "choice",
      instructions:
        `The empty point where placing ${me} makes five ${me} stones in a row. ` +
        `Choose none if no single ${me} move does this.`,
      criteria: withNone,
    },
    must_block: {
      type: "choice",
      instructions:
        `The empty point where ${opp} would make five in a row, or an open four, on ${opp}'s next move ` +
        `if ${me} does not occupy it now. Choose none if ${opp} has no such threat.`,
      criteria: withNone,
    },
    best_move: {
      type: "choice",
      instructions: `The strongest move for ${me} in this position to win the game.`,
      criteria,
    },
  };
  return { state, questions, legal: new Set(Object.keys(criteria)) };
}

async function callJev(be, state, questions) {
  const url = be.kind === "native" ? NATIVE_URL : GATEWAY_URL;
  const model = be.kind === "native" ? "jev-latest" : "typesafe-ai/jev";
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${be.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
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
    model: data.model || model,
  };
}

// Heuristic stand-in when no key is configured. Imperfect on purpose, so the UI shows misses too.
export function mockAnswers(board, me, opp, legal, truth, rng = Math.random) {
  const pts = G.emptyPoints(board);
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

  const peaked = (choice) => {
    const probs = {};
    for (const k of legal) probs[k] = 0.1 / legal.size;
    probs.none = 0.1 / (legal.size + 1);
    probs[choice] = 0.9;
    return { type: "choice", choice, probabilities: probs };
  };
  const pick = (arr, hitRate) => (arr.length && rng() < hitRate ? arr[Math.floor(rng() * arr.length)] : "none");
  return {
    win_now: peaked(pick(truth.win, 0.85)),
    must_block: peaked(pick(truth.block, 0.7)),
    best_move: { type: "choice", choice: G.argmax(best), probabilities: best },
  };
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

// Priority: verified win, else verified block, else best_move. A wrong claim falls through.
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

const reply = (status, body) => ({ status, body });

export async function handleMove(body, env = {}) {
  try {
    const { board: rows, moves = [], humanMove = null, jev = "O", assist = false } = body || {};
    if (jev !== "X" && jev !== "O") throw new Error("jev must be X or O");
    if (!Array.isArray(moves)) throw new Error("moves must be an array");
    const me = jev, opp = jev === "X" ? "O" : "X";
    const board = G.parseBoard(rows);
    const mv = moves.slice();
    const be = backend(env);

    if (humanMove) {
      if (G.toMove(board) !== opp) throw new Error("not the human's turn");
      const p = G.fromKey(humanMove);
      if (!p || board[p.r][p.c] !== ".") throw new Error("illegal human move");
      board[p.r][p.c] = opp;
      mv.push(`${opp} ${humanMove}`);
      if (G.isWinAt(board, p.r, p.c))
        return reply(200, { ok: true, board: G.toRows(board), moves: mv, status: "human_wins", backend: be.kind, jev: null });
      if (G.emptyPoints(board).length === 0)
        return reply(200, { ok: true, board: G.toRows(board), moves: mv, status: "draw", backend: be.kind, jev: null });
    }
    if (G.toMove(board) !== me) throw new Error("not Jev's turn");

    const truth = G.threatSets(board, me, opp);
    const { state, questions, legal } = buildRequest(board, mv, me, opp, !!assist);

    const t0 = Date.now();
    let answers, usage = null, model = null;
    if (be.kind === "mock") {
      answers = mockAnswers(board, me, opp, legal, truth);
      await new Promise((r) => setTimeout(r, 60));
      model = "mock-heuristic";
    } else {
      ({ answers, usage, model } = await callJev(be, state, questions));
    }
    const latencyMs = Date.now() - t0;

    const d = decide(answers, truth, legal);
    const p = G.fromKey(d.move);
    board[p.r][p.c] = me;
    mv.push(`${me} ${d.move}`);
    let status = "playing";
    if (G.isWinAt(board, p.r, p.c)) status = "jev_wins";
    else if (G.emptyPoints(board).length === 0) status = "draw";

    const pack = (a) => ({ choice: a.choice, confidence: Number(a.conf.toFixed(3)), top: a.top.map(([k, v]) => [k, Number(v.toFixed(4))]) });
    return reply(200, {
      ok: true,
      board: G.toRows(board),
      moves: mv,
      status,
      backend: be.kind,
      jev: {
        move: d.move,
        source: d.source,
        latencyMs,
        usage,
        model,
        assist: !!assist,
        optionCount: legal.size,
        truth,
        verdict: d.verdict,
        answers: { win_now: pack(d.win), must_block: pack(d.block), best_move: pack(d.best) },
      },
    });
  } catch (e) {
    return reply(e.status || 400, { ok: false, error: String(e.message || e) });
  }
}
