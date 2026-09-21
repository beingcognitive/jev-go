-- For a games table created before commit ba0f5cb (sign-in): adds the column and index that schema.sql
-- now declares. CREATE TABLE IF NOT EXISTS never alters an existing table, so re-running schema.sql is
-- not enough. Run the two statements ONE AT A TIME in the D1 console: it stops at the first error, so a
-- "duplicate column name" on the ALTER (the column is already there) would otherwise skip the index.
-- Run the CREATE INDEX anyway; it is idempotent.
ALTER TABLE games ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS games_user ON games (user_id, created_at);
