// Runtime-agnostic core for 9x9 Go: handleGoMove(body, env) -> { status, body }.
// The move list is the source of truth; it is replayed once per request (positional superko needs the history).

import * as Go from "./go.js";
import { backend, ask as askJev, mockFromScores, readAnswer, pack, verdict, normalizeMode } from "./jev.js";

const reply = (status, body) => ({ status, body });
const RULES =
  `Go on a 9x9 board. X is black and moves first, O is white. Coordinates are column letter A-J (there is no I) ` +
  `then row number 1-9. Area scoring with komi ${Go.KOMI} for O. Positional superko. Two consecutive passes end the game.`;

function groupsInAtari(board, color) {
  const out = [], seen = new Set();
  for (let r = 0; r < Go.SIZE; r++) for (let c = 0; c < Go.SIZE; c++) {
    if (board[r][c] !== color || seen.has(r * Go.SIZE + c)) continue;
    const g = Go.group(board, r, c);
    for (const [a, b] of g.stones) seen.add(a * Go.SIZE + b);
    if (g.liberties.size === 1) out.push(`${g.stones.length} stone${g.stones.length > 1 ? "s" : ""} at ${Go.key(...g.stones[0])}`);
  }
  return out;
}
function baseState(st, moves, me, opp, hints = true) {
  const s = {
    game: RULES, you_are: me, to_move: me,
    board: Go.render(st.board).split("\n"),
    captured_so_far: { X: st.captures.X, O: st.captures.O },
    move_number: st.count + 1,
    recent_moves: moves.slice(-10),
  };
  if (hints) {
    const mine = groupsInAtari(st.board, me), theirs = groupsInAtari(st.board, opp);
    if (mine.length) s[`${me}_groups_in_atari`] = mine;
    if (theirs.length) s[`${opp}_groups_in_atari`] = theirs;
  }
  return s;
}

export const goTruth = (analyses) => ({
  capture: analyses.filter((a) => a.captured > 0).map((a) => a.key),
  save: analyses.filter((a) => a.saved > 0).map((a) => a.key),
});

const byPosition = (analyses) => [...analyses].sort((a, b) => a.r - b.r || a.c - b.c);

// naked / assisted: every legal point plus pass, in board order (never in heuristic order); three questions.
export function buildGoFullRequest(st, moves, me, opp, analyses, mode, nullOk = true) {
  const points = {};
  for (const a of byPosition(analyses)) points[a.key] = mode === "assisted" ? a.desc : nullOk ? null : a.key;
  const criteria = { ...points, pass: mode === "assisted" ? Go.PASS_DESC(opp) : nullOk ? null : "pass" };
  const questions = {
    capture_now: {
      type: "choice",
      instructions: `A point where ${me} captures one or more ${opp} stones with this move. Choose none if no ${me} move captures anything.`,
      criteria: { none: "No move captures.", ...points },
    },
    must_save: {
      type: "choice",
      instructions:
        `The point that rescues a ${me} group that has exactly one liberty, by giving it two or more liberties or by capturing the attacker. ` +
        `Choose none if no ${me} group is in atari.`,
      criteria: { none: "No group needs saving.", ...points },
    },
    best_move: { type: "choice", instructions: `The best move for ${me} to win the game on points.`, criteria },
  };
  return { state: baseState(st, moves, me, opp, mode !== "naked"), questions, legal: new Set(Object.keys(criteria)) };
}

// player: code filters and ranks; Jev picks from the pool. Pass is offered when the opponent just passed,
// when nothing scores, or near the move cap. A single legal point is played without a call only when pass is not on offer.
export function goPlayerPlan(st, me, opp, analyses, max = 12) {
  if (!analyses.length) return { forced: { move: "pass", source: "forced-pass", note: "no legal move" } };
  const pool = analyses.slice(0, max);
  const includePass = st.last === "pass" || pool[0].score <= 1 || st.count >= Go.MAX_MOVES - 10;
  if (analyses.length === 1 && !includePass) return { forced: { move: analyses[0].key, source: "only-move", note: "single legal move" } };
  if (analyses.length === 1 && analyses[0].score <= 0) return { forced: { move: "pass", source: "forced-pass", note: "only legal move is worse than passing" } };
  return { pool, includePass, all: analyses };
}
export function buildGoPlayerRequest(st, moves, me, opp, plan) {
  const criteria = {};
  for (const a of plan.pool) criteria[a.key] = a.desc;
  if (plan.includePass) criteria.pass = Go.PASS_DESC(opp);
  const questions = {
    best_move: {
      type: "choice",
      instructions:
        `The best move for ${me} to win the game on points. Each option states exactly what it captures, saves or threatens ` +
        `and how many liberties the stone's group has afterwards, computed from the board.`,
      criteria,
    },
  };
  return { state: baseState(st, moves, me, opp), questions, legal: new Set(Object.keys(criteria)) };
}

export async function handleGoMove(body, env = {}) {
  try {
    const { moves = [], humanMove = null, jev = "O" } = body || {};
    const mode = normalizeMode(body && body.mode);
    if (jev !== "X" && jev !== "O") throw new Error("jev must be X or O");
    if (!Array.isArray(moves) || moves.length > Go.MAX_MOVES) throw new Error(`moves must be an array of at most ${Go.MAX_MOVES} moves`);
    const me = jev, opp = Go.other(jev);
    const be = backend(env);
    const mv = moves.slice();
    let st = Go.replay(mv);
    const ended = () => st.passes >= 2 || st.count >= Go.MAX_MOVES;
    const done = (status, jevInfo, score = null) =>
      reply(200, { ok: true, game: "go", moves: mv, board: Go.toRows(st.board), captures: st.captures, toMove: st.toMove, status, score, backend: be.kind, mode, jev: jevInfo });
    const finish = (jevInfo) => { const sc = Go.score(st.board); return done(sc.winner === me ? "jev_wins" : "human_wins", jevInfo, sc); };
    if (ended()) throw new Error("game is over");

    if (humanMove) {
      if (st.toMove !== opp) throw new Error("not the human's turn");
      st = Go.applyMove(st, `${opp} ${humanMove}`);
      mv.push(`${opp} ${humanMove}`);
      if (ended()) return finish(null);
    }
    if (st.toMove !== me) throw new Error("not Jev's turn");

    const analyses = Go.analyzeAll(st.board, me, opp, st.history, st.last);
    const slim = (a, i) => ({ key: a.key, desc: a.desc, score: Math.round(a.score * 10) / 10, rank: i + 1 });
    let info;
    if (mode === "player") {
      const plan = goPlayerPlan(st, me, opp, analyses);
      const base = { mode, truth: null, verdict: null };
      if (plan.forced) {
        info = { ...base, move: plan.forced.move, source: plan.forced.source, note: plan.forced.note, latencyMs: 0, usage: null, model: null, optionCount: 0, answers: null, candidates: [], heuristicRank: null, io: null };
      } else {
        const { state, questions, legal } = buildGoPlayerRequest(st, mv, me, opp, plan);
        const scores = Object.fromEntries(plan.pool.map((a) => [a.key, a.score]));
        if (plan.includePass) scores.pass = 0;
        const r = await askJev(be, state, questions, () => mockFromScores(scores, legal, null));
        const best = readAnswer(r.answers.best_move);
        const ok = best.choice !== null && legal.has(best.choice);
        const move = ok ? best.choice : plan.pool[0].key;
        const candidates = plan.pool.map(slim);
        if (plan.includePass) candidates.push({ key: "pass", desc: Go.PASS_DESC(opp), score: 0, rank: null });
        info = {
          ...base, move, source: ok ? "best" : "fallback", note: plan.includePass ? "pass offered" : null,
          latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size,
          answers: { best_move: pack(best) }, candidates, heuristicRank: move === "pass" ? null : analyses.findIndex((a) => a.key === move) + 1, io: r.io,
        };
      }
    } else {
      const truth = goTruth(analyses);
      const { state, questions, legal } = buildGoFullRequest(st, mv, me, opp, analyses, mode, be.kind !== "gateway");
      const scores = Object.fromEntries(analyses.map((a) => [a.key, a.score]));
      scores.pass = -5;
      const r = await askJev(be, state, questions, () =>
        mockFromScores(scores, legal, { capture_now: { truth: truth.capture, hitRate: 0.85 }, must_save: { truth: truth.save, hitRate: 0.7 } }));
      const cap = readAnswer(r.answers.capture_now), sav = readAnswer(r.answers.must_save), best = readAnswer(r.answers.best_move);
      const v = { capture: verdict(cap.choice, truth.capture), save: verdict(sav.choice, truth.save) };
      let move, source;
      if (cap.choice !== "none" && truth.capture.includes(cap.choice)) { move = cap.choice; source = "capture"; }
      else if (sav.choice !== "none" && truth.save.includes(sav.choice)) { move = sav.choice; source = "save"; }
      else if (best.choice !== null && legal.has(best.choice)) { move = best.choice; source = "best"; }
      else { move = analyses[0] ? analyses[0].key : "pass"; source = "fallback"; }
      info = {
        mode, move, source, note: null, latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size, truth, verdict: v,
        answers: { capture_now: pack(cap), must_save: pack(sav), best_move: pack(best) }, candidates: [],
        heuristicRank: move === "pass" ? null : analyses.findIndex((a) => a.key === move) + 1, io: r.io,
      };
    }

    st = Go.applyMove(st, `${me} ${info.move}`);
    mv.push(`${me} ${info.move}`);
    if (ended()) return finish(info);
    return done("playing", info);
  } catch (e) {
    return reply(e.status || 400, { ok: false, error: String(e.message || e) });
  }
}
