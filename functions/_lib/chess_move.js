// Runtime-agnostic core for chess: handleChessMove(body, env) -> { status, body }.
// The SAN move list is the source of truth and is replayed every request. X = White, O = Black.

import * as C from "./chess.js";
import { backend, ask as askJev, mockFromScores, readAnswer, pack, verdict, normalizeMode } from "./jev.js";

const reply = (status, body) => ({ status, body });
const RULES = "Standard chess. X is White and moves first, O is Black. Moves are in standard algebraic notation (SAN).";
const sideName = (c) => (c === "w" ? "White" : "Black");

function baseState(c, moves, me, hints = true) {
  const mat = C.material(c);
  const s = {
    game: RULES, you_are: `${me === "w" ? "X" : "O"} (${sideName(me)})`, to_move: sideName(c.turn()),
    fen: c.fen(), board: C.render(c).split("\n"), material: { White: mat.w, Black: mat.b }, move_number: c.moveNumber(),
    recent_moves: moves.slice(-10),
  };
  if (hints && c.inCheck()) s.in_check = true;
  return s;
}

// naked / assisted: every legal move (SAN) plus three questions.
export function buildChessFullRequest(c, moves, me, analyses, mode, nullOk = true) {
  const ordered = [...analyses].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const points = {};
  for (const a of ordered) points[a.key] = mode === "assisted" ? a.desc : nullOk ? null : a.key;
  const opp = sideName(C.otherColor(me));
  const questions = {
    mate_now: { type: "choice", instructions: `The move that delivers checkmate. Choose none if no legal move checkmates.`, criteria: { none: "No move checkmates.", ...points } },
    win_material: {
      type: "choice",
      instructions: `A move that captures a ${opp} piece and wins material, i.e. the capturing piece cannot simply be taken back for a loss. Choose none if no capture wins material.`,
      criteria: { none: "No capture wins material.", ...points },
    },
    best_move: { type: "choice", instructions: `The best move for ${sideName(me)} in this position.`, criteria: points },
  };
  return { state: baseState(c, moves, me, mode !== "naked"), questions, legal: new Set(Object.keys(points)) };
}

// player: code plays mate in one and single legal moves; otherwise Jev picks from the ranked pool.
export function chessPlayerPlan(analyses, max = 12) {
  if (!analyses.length) return { forced: { move: null, source: "no-move", note: "no legal move" } };
  const mate = analyses.find((a) => a.mate);
  if (mate) return { forced: { move: mate.key, source: "forced-mate", note: null } };
  if (analyses.length === 1) return { forced: { move: analyses[0].key, source: "only-move", note: "single legal move" } };
  return { pool: analyses.slice(0, max), all: analyses };
}
export function buildChessPlayerRequest(c, moves, me, plan) {
  const criteria = {};
  for (const a of plan.pool) criteria[a.key] = a.desc;
  const questions = {
    best_move: {
      type: "choice",
      instructions:
        `The best move for ${sideName(me)}. Each option states exactly what it captures, whether it gives check, ` +
        `what it leaves hanging and what the opponent could then take, computed from the position.`,
      criteria,
    },
  };
  return { state: baseState(c, moves, me), questions, legal: new Set(Object.keys(criteria)) };
}

export async function handleChessMove(body, env = {}) {
  try {
    const { moves = [], humanMove = null, jev = "O" } = body || {};
    const mode = normalizeMode(body && body.mode);
    if (jev !== "X" && jev !== "O") throw new Error("jev must be X or O");
    const me = C.colorOf(jev), opp = C.otherColor(me);
    const be = backend(env);
    const mv = moves.slice();
    const c = C.replay(mv);
    const done = (status, jevInfo, extra = {}) => {
      const st = C.status(c);
      return reply(200, {
        ok: true, game: "chess", moves: mv, board: C.boardRows(c), fen: c.fen(), turn: c.turn(), inCheck: c.inCheck(),
        legal: status === "playing" && c.turn() === opp ? C.slimLegal(c) : [],
        lastMove: (() => { const h = c.history({ verbose: true }); const l = h[h.length - 1]; return l ? { san: l.san, from: l.from, to: l.to } : null; })(),
        status, result: st.result, backend: be.kind, mode, jev: jevInfo, ...extra,
      });
    };
    const finish = (jevInfo) => { const st = C.status(c); return done(st.winner === null ? "draw" : st.winner === me ? "jev_wins" : "human_wins", jevInfo); };
    if (C.status(c).over) throw new Error("game is over");

    if (humanMove !== null) {
      if (c.turn() !== opp) throw new Error("not the human's turn");
      if (typeof humanMove !== "string" || humanMove.length > 10) throw new Error("illegal move");
      let m;
      try { m = c.move(humanMove); } catch { throw new Error("illegal move"); }
      if (m.san === "--") { c.undo(); throw new Error("illegal move"); }
      mv.push(m.san);
      if (C.status(c).over) return finish(null);
    } else if (c.turn() === opp) {
      return done("playing", null); // state query: the human's legal moves
    }

    const analyses = C.analyzeAll(c);
    const sanMap = Object.fromEntries(analyses.map((a) => [a.key, { from: a.from, to: a.to }]));
    const slim = (a, i) => ({ key: a.key, desc: a.desc, score: Math.round(a.score * 10) / 10, rank: i + 1, from: a.from, to: a.to });
    let info;
    if (mode === "player") {
      const plan = chessPlayerPlan(analyses);
      const base = { mode, truth: null, verdict: null, sanMap };
      if (plan.forced) {
        if (!plan.forced.move) throw new Error("no legal move");
        info = { ...base, move: plan.forced.move, source: plan.forced.source, note: plan.forced.note, latencyMs: 0, usage: null, model: null, optionCount: 0, answers: null, candidates: analyses.slice(0, 12).map(slim), heuristicRank: analyses.findIndex((a) => a.key === plan.forced.move) + 1, io: null };
      } else {
        const { state, questions, legal } = buildChessPlayerRequest(c, mv, me, plan);
        const scores = Object.fromEntries(plan.pool.map((a) => [a.key, a.score]));
        const r = await askJev(be, state, questions, () => mockFromScores(scores, legal, null));
        const best = readAnswer(r.answers.best_move);
        const ok = best.choice !== null && legal.has(best.choice);
        const move = ok ? best.choice : plan.pool[0].key;
        info = {
          ...base, move, source: ok ? "best" : "fallback", note: null, latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size,
          answers: { best_move: pack(best) }, candidates: plan.pool.map(slim), heuristicRank: analyses.findIndex((a) => a.key === move) + 1, io: r.io,
        };
      }
    } else {
      const truth = C.truthOf(analyses);
      const { state, questions, legal } = buildChessFullRequest(c, mv, me, analyses, mode, be.kind !== "gateway");
      const scores = Object.fromEntries(analyses.map((a) => [a.key, a.score]));
      const r = await askJev(be, state, questions, () =>
        mockFromScores(scores, legal, { mate_now: { truth: truth.mate, hitRate: 0.85 }, win_material: { truth: truth.material, hitRate: 0.7 } }));
      const mate = readAnswer(r.answers.mate_now), mat = readAnswer(r.answers.win_material), best = readAnswer(r.answers.best_move);
      const v = { mate: verdict(mate.choice, truth.mate), material: verdict(mat.choice, truth.material) };
      let move, source;
      if (mate.choice !== "none" && truth.mate.includes(mate.choice)) { move = mate.choice; source = "mate"; }
      else if (mat.choice !== "none" && truth.material.includes(mat.choice)) { move = mat.choice; source = "material"; }
      else if (best.choice !== null && legal.has(best.choice)) { move = best.choice; source = "best"; }
      else { move = analyses[0].key; source = "fallback"; }
      info = {
        mode, move, source, note: null, latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size, truth, verdict: v, sanMap,
        answers: { mate_now: pack(mate), win_material: pack(mat), best_move: pack(best) }, candidates: [], heuristicRank: analyses.findIndex((a) => a.key === move) + 1, io: r.io,
      };
    }

    c.move(info.move);
    mv.push(info.move);
    if (C.status(c).over) return finish(info);
    return done("playing", info);
  } catch (e) {
    return reply(e.status || 400, { ok: false, error: String(e.message || e) });
  }
}
