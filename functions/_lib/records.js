// Read-side cores: leaderboard, one game's replay, and a winner's name claim.
import { storeFor } from "./store.js";
import { verify } from "./token.js";
import { secretOf } from "./session.js";
import { userFromSession } from "./auth.js";
import { backend } from "./jev.js";

const GAMES = new Set(["gomoku", "go", "chess"]);
const reply = (status, body) => ({ status, body });

export async function handleLeaderboard(params, query, env = {}) {
  const game = String(query.game || "gomoku");
  if (!GAMES.has(game)) return reply(400, { ok: false, error: "unknown game" });
  const store = storeFor(env);
  const [wins, stats, schema] = await Promise.all([store.leaderboard(game), store.stats(game), store.probe().catch((e) => String(e.message || e))]);
  return reply(200, { ok: true, game, wins, stats, durable: store.kind === "d1", schema, backend: backend(env).kind }); // schema: "ok", or the database's own error; backend tells the page whether play needs a sign-in
}

export async function handleGame(params, query, env = {}) {
  const id = String(params.id || "");
  if (!/^[0-9a-f]{16}$/.test(id)) return reply(400, { ok: false, error: "bad id" });
  const store = storeFor(env);
  const game = await store.getGame(id);
  if (!game) return reply(404, { ok: false, error: "no such game" });
  const turns = (await store.getTurns(id)).map((t) => ({
    ply: t.ply, side: t.side, move: t.move, board: t.board, source: t.source, heuristicRank: t.heuristic_rank,
    verdict: t.verdict, heat: t.heat, pick: t.pick, latencyMs: t.latency_ms, inputTokens: t.input_tokens, outputTokens: t.output_tokens,
    io: query.io === "1" ? t.io : undefined,
  }));
  const { id: gid, game: g, mode, jev, backend, model, result, plies, name, created_at, ended_at } = game;
  return { status: 200, cache: !!result, body: { ok: true, game: { id: gid, game: g, mode, jev, backend, model, result, plies, name: name || null, created_at, ended_at }, turns } }; // only a finished game may be cached
}

// POST { session }: the signed-in player's recent games.
export async function handleMe(body, env = {}) {
  const user = await userFromSession(env, body && body.session);
  if (!user) return reply(401, { ok: false, error: "not signed in" });
  const games = await storeFor(env).myGames(user.id);
  const stats = { games: 0, wins: 0, losses: 0, draws: 0 };
  for (const g of games) { if (!g.result || g.backend === "mock") continue; stats.games++; if (g.result === "human_wins") stats.wins++; else if (g.result === "jev_wins") stats.losses++; else stats.draws++; }
  return reply(200, { ok: true, user, games, stats });
}

// POST { state, name }: the state token proves the caller played the game; the store checks it was a human win.
export async function handleClaim(body, env = {}) {
  try {
    const { state, name } = body || {};
    const p = await verify(state, secretOf(env));
    if (!p || typeof p.id !== "string") throw new Error("bad state");
    const clean = String(name ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24);
    if (!clean) throw new Error("name required");
    const g = await storeFor(env).claim(p.id, clean);
    if (!g) throw new Error("not a claimable win");
    return reply(200, { ok: true, id: g.id, name: g.name });
  } catch (e) {
    return reply(400, { ok: false, error: String(e.message || e) });
  }
}
