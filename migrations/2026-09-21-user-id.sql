-- For a games table created before commit ba0f5cb (sign-in): adds the column and index that schema.sql
-- now declares. CREATE TABLE IF NOT EXISTS never alters an existing table, so re-running schema.sql is
-- not enough. Run in the D1 console. "duplicate column name" means it was already applied.
ALTER TABLE games ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS games_user ON games (user_id, created_at);
