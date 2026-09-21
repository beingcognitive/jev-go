// A game session is a signed token that binds a game id to the exact position the server last produced.
// The server continues a game only from a token it issued (or from the empty starting position), so every
// recorded result was produced move by move on the server. Payload: { g: game, id, n: plies, pos }.

import { sign, verify } from "./token.js";

export const secretOf = (env = {}) => env.STATE_SECRET || env.TYPESAFE_API_KEY || "mock-only-secret";
export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

// Returns { id, n, pos, verified, created }. `state` absent: a fresh verified game only if `isFresh`,
// otherwise an unverified game (playable, never recorded). A present but invalid token throws "bad state".
export async function openSession(env, state, game, isFresh) {
  if (state !== null && state !== undefined) {
    const p = await verify(state, secretOf(env));
    if (!p || p.g !== game || typeof p.id !== "string" || typeof p.n !== "number") throw new Error("bad state");
    return { id: p.id, n: p.n, pos: p.pos, verified: true, created: p.t || null };
  }
  return { id: newId(), n: 0, pos: null, verified: !!isFresh, created: Date.now() };
}

export const sealSession = (env, game, s, n, pos) => sign({ g: game, id: s.id, n, pos, t: s.created || Date.now() }, secretOf(env));

// One request may produce a human ply and a Jev ply; both go to the store as turns. Jev's overlay data
// (top probabilities keyed by board square, the played move's probability) is resolved here so a replay
// needs no engine.
export function turnRows(gameId, startPly, board, humanMove, jevInfo, jevBoard, toSquare = (k) => k) {
  const rows = [];
  let ply = startPly;
  if (humanMove) rows.push({ game_id: gameId, ply: ply++, side: "human", move: humanMove, board, source: "human" });
  if (jevInfo) {
    const top = jevInfo.answers ? jevInfo.answers.best_move.top : [];
    const heat = top.filter(([k]) => k !== "pass").map(([k, p]) => [toSquare(k), p]);
    const pickEntry = top.find(([k]) => k === jevInfo.move);
    rows.push({
      game_id: gameId, ply: ply++, side: "jev", move: jevInfo.move, board: jevBoard, source: jevInfo.source,
      heuristic_rank: jevInfo.heuristicRank, verdict: jevInfo.verdict, heat, pick: pickEntry ? pickEntry[1] : null,
      latency_ms: jevInfo.latencyMs, input_tokens: jevInfo.usage ? jevInfo.usage.input : null, output_tokens: jevInfo.usage ? jevInfo.usage.output : null,
      io: jevInfo.io,
    });
  }
  return rows;
}

// Persist a request's outcome. Returns a promise the adapter hands to waitUntil.
export async function record(store, game, s, { mode, jev, backend, model, status, plies, rows, user }) {
  if (!s.verified) return;
  const over = status !== "playing";
  await store.upsertGame({ id: s.id, game, mode, jev, backend, model: model || null, result: over ? status : null, plies, created_at: s.created || Date.now(), ended_at: over ? Date.now() : null,
    user_id: user ? user.id : null, name: user ? user.name : null });
  for (const r of rows) await store.addTurn(r);
}
