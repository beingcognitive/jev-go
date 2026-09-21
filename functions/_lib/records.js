// Read-side cores: leaderboard, one game's replay, and the signed-in player's games.
import { storeFor } from "./store.js";
import { userFromSession } from "./auth.js";
import { backend } from "./jev.js";

const GAMES = new Set(["gomoku", "go", "chess"]);
const reply = (status, body) => ({ status, body });

// The schema cannot change between requests of one isolate, so it is probed once per database and the answer kept.
let probes = new WeakMap();
export const resetSchemaProbe = () => { probes = new WeakMap(); };
export async function handleLeaderboard(params, query, env = {}) {
  const game = String(query.game || "gomoku");
  if (!GAMES.has(game)) return reply(400, { ok: false, error: "unknown game" });
  const store = storeFor(env);
  const err = (e) => String(e && e.message || e);
  const key = env.DB || store; let probe = probes.get(key); if (!probe) { probe = store.probe().catch(err); probes.set(key, probe); }
  const [wins, stats, schema] = await Promise.all([store.leaderboard(game).catch(() => null), store.stats(game).catch(() => null), probe]);
  if (schema !== "ok") probes.delete(key); // a failed probe is retried next time, so a migration shows up without a redeploy
  // schema: "ok", or the database's own error (then nothing is being recorded); partial: a read failed, so the page must not show an empty board as fact
  return reply(200, { ok: true, game, wins: wins || [], stats: stats || { games: 0, jev_wins: 0, human_wins: 0, draws: 0 }, partial: !wins || !stats, durable: store.kind === "d1", schema, backend: backend(env).kind });
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
  const { id: gid, game: g, mode, jev, backend: be, model, result, plies, name, created_at, ended_at } = game;
  return { status: 200, cache: !!result, body: { ok: true, game: { id: gid, game: g, mode, jev, backend: be, model, result, plies, name: name || null, created_at, ended_at }, turns } }; // only a finished game may be cached
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

