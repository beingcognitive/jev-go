// Game records: one row per game, one row per ply. Backed by Cloudflare D1 when `env.DB` is bound,
// otherwise by an in-process memory store (local dev and tests; not durable).

const LEADERBOARD_LIMIT = 50;

export function memoryStore() {
  const games = new Map(), turns = new Map(), counters = new Map();
  return {
    kind: "memory",
    async upsertGame(g) {
      const prev = games.get(g.id);
      games.set(g.id, { ...(prev || {}), ...g });
      if (g.result && !(prev && prev.result) && g.backend === "native") { const k = `${g.game}|${g.result}`; counters.set(k, (counters.get(k) || 0) + 1); }
    },
    async addTurn(t) { const arr = turns.get(t.game_id) || []; arr[t.ply] = t; turns.set(t.game_id, arr); },
    async getGame(id) { return games.get(id) || null; },
    async getTurns(id) { return (turns.get(id) || []).filter(Boolean); },
    async claim(id, name) {
      const g = games.get(id);
      if (!g || g.result !== "human_wins" || g.name) return null;
      g.name = name;
      return g;
    },
    async leaderboard(game) {
      return [...games.values()]
        .filter((g) => g.game === game && g.result === "human_wins" && g.backend === "native")
        .sort((a, b) => a.plies - b.plies || b.ended_at - a.ended_at)
        .slice(0, LEADERBOARD_LIMIT)
        .map(publicGame);
    },
    async stats(game) {
      const n = (r) => counters.get(`${game}|${r}`) || 0;
      const out = { jev_wins: n("jev_wins"), human_wins: n("human_wins"), draws: n("draw") };
      return { games: out.jev_wins + out.human_wins + out.draws, ...out };
    },
  };
}

export function d1Store(db) {
  return {
    kind: "d1",
    async upsertGame(g) {
      await db.prepare(
        `INSERT INTO games (id, game, mode, jev, backend, model, result, plies, name, created_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET mode = ?3, model = COALESCE(?6, games.model), result = ?7, plies = ?8, ended_at = ?10`,
      ).bind(g.id, g.game, g.mode, g.jev, g.backend, g.model ?? null, g.result ?? null, g.plies, g.created_at, g.ended_at ?? null).run();
      // Counters keep stats() at three row reads instead of a scan; a game ends exactly once, so this runs once per game.
      if (g.result && g.backend === "native") {
        await db.prepare("INSERT INTO counters (game, result, n) VALUES (?1, ?2, 1) ON CONFLICT(game, result) DO UPDATE SET n = n + 1").bind(g.game, g.result).run();
      }
    },
    async addTurn(t) {
      await db.prepare(
        `INSERT OR REPLACE INTO turns (game_id, ply, side, move, board, source, heuristic_rank, verdict, heat, pick, latency_ms, input_tokens, output_tokens, io)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      ).bind(t.game_id, t.ply, t.side, t.move, JSON.stringify(t.board), t.source ?? null, t.heuristic_rank ?? null,
        t.verdict ? JSON.stringify(t.verdict) : null, t.heat ? JSON.stringify(t.heat) : null, t.pick ?? null,
        t.latency_ms ?? null, t.input_tokens ?? null, t.output_tokens ?? null, t.io ? JSON.stringify(t.io) : null).run();
    },
    async getGame(id) { return (await db.prepare("SELECT * FROM games WHERE id = ?1").bind(id).first()) || null; },
    async getTurns(id) {
      const { results } = await db.prepare("SELECT * FROM turns WHERE game_id = ?1 ORDER BY ply").bind(id).all();
      return results.map((t) => ({ ...t, board: JSON.parse(t.board), verdict: t.verdict ? JSON.parse(t.verdict) : null, heat: t.heat ? JSON.parse(t.heat) : null, io: t.io ? JSON.parse(t.io) : null }));
    },
    async claim(id, name) {
      const r = await db.prepare("UPDATE games SET name = ?2 WHERE id = ?1 AND result = 'human_wins' AND name IS NULL").bind(id, name).run();
      return r.meta && r.meta.changes ? this.getGame(id) : null;
    },
    async leaderboard(game) {
      const { results } = await db.prepare(
        `SELECT id, game, mode, plies, name, model, ended_at FROM games
         WHERE game = ?1 AND result = 'human_wins' AND backend = 'native'
         ORDER BY plies ASC, ended_at DESC LIMIT ${LEADERBOARD_LIMIT}`,
      ).bind(game).all();
      return results.map(publicGame);
    },
    async stats(game) {
      const { results } = await db.prepare("SELECT result, n FROM counters WHERE game = ?1").bind(game).all();
      const out = { games: 0, jev_wins: 0, human_wins: 0, draws: 0 };
      for (const r of results) { out.games += r.n; if (r.result === "jev_wins") out.jev_wins += r.n; else if (r.result === "human_wins") out.human_wins += r.n; else out.draws += r.n; }
      return out;
    },
  };
}

const publicGame = (g) => ({ id: g.id, game: g.game, mode: g.mode, plies: g.plies, name: g.name || "anonymous", model: g.model || null, ended_at: g.ended_at });

let memory = null;
export function storeFor(env = {}) {
  if (env.DB) return d1Store(env.DB);
  return (memory ||= memoryStore());
}
