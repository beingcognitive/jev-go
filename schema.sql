-- D1 schema for game records. Apply with:
--   npx wrangler d1 execute jev-go --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,          -- gomoku | go | chess
  mode TEXT NOT NULL,          -- player | assisted | naked
  jev TEXT NOT NULL,           -- X | O (the side Jev played)
  backend TEXT NOT NULL,       -- native | mock
  model TEXT,                  -- e.g. jev-1.13.0
  result TEXT,                 -- jev_wins | human_wins | draw, NULL while playing
  plies INTEGER NOT NULL,
  name TEXT,                   -- winner's display name, claimed once
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS games_leaderboard ON games (game, result, backend, plies, ended_at);

CREATE TABLE IF NOT EXISTS turns (
  game_id TEXT NOT NULL,
  ply INTEGER NOT NULL,
  side TEXT NOT NULL,          -- human | jev
  move TEXT NOT NULL,
  board TEXT NOT NULL,         -- JSON rows after the move
  source TEXT,
  heuristic_rank INTEGER,
  verdict TEXT,                -- JSON
  heat TEXT,                   -- JSON [[square, probability], ...]
  pick REAL,                   -- probability Jev gave the move it played
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  io TEXT,                     -- JSON { request, response }
  PRIMARY KEY (game_id, ply)
);

-- Per-game-type result counters, so the leaderboard's stats read three rows instead of scanning games.
CREATE TABLE IF NOT EXISTS counters (
  game TEXT NOT NULL,
  result TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game, result)
);
