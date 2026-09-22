// Runtime-agnostic core for Gomoku: handleMove(body, env) -> { status, body }.
// Modes:
//   player   code does perception + forced tactics; Jev chooses among ranked, annotated candidates
//   assisted every empty point is an option, annotated with exact line facts; Jev decides everything
//   naked    every empty point is an option with no description; Jev decides everything (measurement)

import * as G from "./gomoku.js";
import { backend, ask as askJev, mockFromScores, readAnswer, pack, verdict, normalizeMode, MODES } from "./jev.js";
import { openSession, sealSession, turnRows, record } from "./session.js";
import { storeFor } from "./store.js";
import { userFromSession } from "./auth.js";
export { backend, normalizeMode, MODES };

const RULES =
  "Gomoku on a 15x15 board. Five in a row wins. X is black, O is white, . is empty. " +
  "Coordinates are column letter A-O then row number 1-15.";
const MOVE_RE = /^[XO] [A-O](?:[1-9]|1[0-5])$/;

function baseState(board, moves, me) {
  return { game: RULES, you_are: me, to_move: me, board: G.render(board).split("\n"), recent_moves: moves.slice(-12) };
}

// naked / assisted: every empty point, three questions.
export function buildFullRequest(board, moves, me, opp, mode) {
  const criteria = {};
  for (const p of G.emptyPoints(board)) {
    criteria[p.key] = mode === "assisted" ? G.describe(board, p.r, p.c, me, opp) : null;
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
        `The empty point ${me} must occupy now to stop ${opp} winning: where ${opp} would make five in a row on ${opp}'s next move, ` +
        `or, only when ${opp} has no such point, where ${opp} would make an unstoppable threat: an open four, two fours at once, ` +
        `or a four plus an open three. Choose none if ${opp} has no such threat.`,
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
  // Forks that win outright get their own line: a four-plus-three is not "a four", and two open threes are not "an open three".
  for (const [side, who] of [["opp", opp], ["me", me]]) {
    add(`${who}_can_make_open_four_at`, pick(side, ["open_four"]));
    add(`${who}_wins_outright_at`, pick(side, ["four_three", "double_four"]));
    add(`${who}_can_make_four_at`, pick(side, ["four"]));
    add(`${who}_can_make_two_open_threes_at`, pick(side, ["double_three"]));
    add(`${who}_can_make_open_three_at`, pick(side, ["open_three"]));
  }
  return s;
}

// player: code decides forced tactics; otherwise a ranked candidate pool for Jev.
// Candidates that lose by force are dropped; when every checked move loses, code plays the longest defence.
export function playerPlan(board, me, opp, max = 12, budget = undefined) {
  const winPts = G.fivePointsFor(board, me);
  if (winPts.length) return { forced: { move: winPts[0], source: "forced-win", note: null } };
  const oppFive = G.fivePointsFor(board, opp);
  if (oppFive.length)
    return { forced: { move: oppFive[0], source: "forced-block", note: oppFive.length > 1 ? `${opp} has ${oppFive.length} winning points; blocking one` : null } };
  const cands = G.candidates(board, me, opp, max, 30, budget);
  const of = cands.all.find((c) => c.me.cls === "open_four");
  if (of) return { forced: { move: of.key, source: "open-four", note: null }, cands };
  const checked = cands.all.filter((c) => c.checked);
  const safe = checked.filter((c) => !c.danger);
  if (safe.length) return { pool: safe.slice(0, max), cands, oppThreatens: safe.length < checked.length };
  // Every checked move loses by force: blocks of the biggest threat first, to make the opponent prove the win.
  const blocks = [...checked].sort((x, y) => G.VALUE[y.opp.cls] - G.VALUE[x.opp.cls] || y.score - x.score);
  if (cands.exhausted) return { forced: { move: blocks[0].key, source: "longest-defence", note: `every move loses by force; ${blocks[0].desc}` }, cands, lost: true };
  // The search ran out of budget before the ranking: Jev picks among the checked blocks (or, if none was checked, the ranking as it stands).
  return { pool: (blocks.length ? blocks : cands.all).slice(0, max), cands, oppThreatens: blocks.length > 0 };
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

// Heuristic scores for the mock (no key configured).
function mockScores(board, me, opp, legal) {
  const scores = {};
  for (const p of G.emptyPoints(board)) {
    if (!legal.has(p.key)) continue;
    const m = G.lineInfo(board, p.r, p.c, me), o = G.lineInfo(board, p.r, p.c, opp);
    scores[p.key] =
      Math.max(...m.map((l) => l.len * (l.open ? 1.6 : 1))) * 3 +
      0.85 * Math.max(...o.map((l) => l.len * (l.open ? 1.6 : 1))) * 3 +
      Math.random() * 1.5;
  }
  return scores;
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
  else if (best.choice !== null && legal.has(best.choice)) { move = best.choice; source = "best"; }
  else { move = [...legal][0]; source = "fallback"; }
  return { move, source, verdict: v, win, block, best };
}

const reply = (status, body) => ({ status, body });

// The client sends both the board and the move list; the board is the position, the list is context.
function validate(board, moves) {
  if (moves.length > G.SIZE * G.SIZE) throw new Error("too many moves");
  if (!moves.every((m) => typeof m === "string" && MOVE_RE.test(m))) throw new Error("bad entry in moves");
  const { X, O } = G.counts(board);
  if (X !== O && X !== O + 1) throw new Error("impossible stone counts");
  for (let r = 0; r < G.SIZE; r++) for (let c = 0; c < G.SIZE; c++) if (board[r][c] !== "." && G.isWinAt(board, r, c)) throw new Error("game is over");
}

export async function handleMove(body, env = {}) {
  try {
    const { board: rows, moves = [], humanMove = null, jev = "O", state = null } = body || {};
    let mode = normalizeMode(body && body.mode);
    if (jev !== "X" && jev !== "O") throw new Error("jev must be X or O");
    if (!Array.isArray(moves)) throw new Error("moves must be an array");
    const me = jev, opp = jev === "X" ? "O" : "X";
    let board = G.parseBoard(rows);
    const { X: x0, O: o0 } = G.counts(board);
    // A session token makes its board authoritative; without one only the empty board starts a verified game.
    const s = await openSession(env, state, "gomoku", moves.length === 0 && x0 === 0 && o0 === 0, humanMove);
    if (s.mode) mode = s.mode; else s.mode = mode; // the mode is sealed into the session: the client cannot change it mid-game
    if (s.verified && s.pos) {
      if (s.n !== moves.length) throw new Error("bad state");
      board = G.parseBoard(s.pos);
    }
    validate(board, moves);
    const mv = moves.slice();
    const be = backend(env);
    const store = storeFor(env);
    const user = await userFromSession(env, body && body.session);
    if (be.kind === "native" && !user) throw Object.assign(new Error("sign in to play"), { status: 401 }); // every request here ends in a call to Jev: live games are always attributed
    const startPly = mv.length;
    let humanBoard = null, humanKey = null;
    const done = async (status, jevInfo) => ({
      status: 200,
      body: { ok: true, board: G.toRows(board), moves: mv, status, backend: be.kind, mode, jev: jevInfo,
        state: s.verified ? await sealSession(env, "gomoku", s, mv.length, G.toRows(board)) : null, gameId: s.verified ? s.id : null, verified: s.verified, owner: user && mv.length ? user.name : null },
      after: () => record(store, "gomoku", s, { mode, jev, backend: be.kind, model: jevInfo && jevInfo.model, status, plies: mv.length, user,
        rows: turnRows(s.id, startPly, humanBoard, humanKey, jevInfo, G.toRows(board)) }),
    });

    if (humanMove) {
      if (G.toMove(board) !== opp) throw new Error("not the human's turn");
      const p = G.fromKey(humanMove);
      if (!p || board[p.r][p.c] !== ".") throw new Error("illegal human move");
      board[p.r][p.c] = opp;
      humanKey = G.key(p.r, p.c);
      mv.push(`${opp} ${humanKey}`);
      humanBoard = G.toRows(board);
      if (G.isWinAt(board, p.r, p.c)) return done("human_wins", null);
    }
    if (G.toMove(board) !== me) throw new Error("not Jev's turn");
    if (G.emptyPoints(board).length === 0) return done("draw", null);

    let info;
    if (mode === "player") {
      const plan = playerPlan(board, me, opp);
      const slim = (c, i) => ({ key: c.key, desc: c.desc, score: Math.round(c.score), rank: i + 1 });
      const base = { mode, truth: null, verdict: null };
      if (plan.forced) {
        info = { ...base, move: plan.forced.move, source: plan.forced.source, note: plan.forced.note, latencyMs: 0, usage: null, model: null, optionCount: 0, answers: null, candidates: plan.cands ? plan.cands.top.map(slim) : [], heuristicRank: null, io: null };
      } else if (plan.pool.length < 2) {
        const only = plan.pool[0];
        info = { ...base, move: only.key, source: "only-move", note: plan.oppThreatens ? `${opp} threatens; ${only.key} is the single answer` : "single candidate", latencyMs: 0, usage: null, model: null, optionCount: 1, answers: null, candidates: plan.pool.map(slim), heuristicRank: plan.cands.all.findIndex((c) => c.key === only.key) + 1, io: null };
      } else {
        const { state: st, questions, legal } = buildPlayerRequest(board, mv, me, opp, plan);
        const r = await askJev(be, st, questions, () => mockFromScores(mockScores(board, me, opp, legal), legal, null));
        const best = readAnswer(r.answers.best_move);
        const ok = best.choice !== null && legal.has(best.choice);
        const move = ok ? best.choice : plan.pool[0].key;
        info = {
          ...base, move, source: ok ? "best" : "fallback", note: plan.oppThreatens ? `${opp} threatens; pool restricted to answers` : null,
          latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size,
          answers: { best_move: pack(best) }, candidates: plan.pool.map(slim), heuristicRank: plan.cands.all.findIndex((c) => c.key === move) + 1, io: r.io,
        };
      }
    } else {
      const truth = G.threatSets(board, me, opp);
      const { state: st, questions, legal } = buildFullRequest(board, mv, me, opp, mode);
      const r = await askJev(be, st, questions, () =>
        mockFromScores(mockScores(board, me, opp, legal), legal, { win_now: { truth: truth.win, hitRate: 0.85 }, must_block: { truth: truth.block, hitRate: 0.7 } }));
      const d = decide(r.answers, truth, legal);
      info = {
        mode, move: d.move, source: d.source, note: null, latencyMs: r.latencyMs, usage: r.usage, model: r.model, optionCount: legal.size, truth, verdict: d.verdict,
        answers: { win_now: pack(d.win), must_block: pack(d.block), best_move: pack(d.best) }, candidates: [], heuristicRank: null, io: r.io,
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
