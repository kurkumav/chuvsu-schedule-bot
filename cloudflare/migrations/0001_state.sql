CREATE TABLE users (
  chat_id INTEGER PRIMARY KEY,
  subgroup INTEGER NOT NULL DEFAULT 0 CHECK (subgroup IN (0, 1, 2)),
  subscribed INTEGER NOT NULL DEFAULT 0 CHECK (subscribed IN (0, 1)),
  last_sent TEXT,
  since_date TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
CREATE INDEX users_subscribed ON users (subscribed, lease_until);
CREATE TABLE updates (
  update_id INTEGER PRIMARY KEY,
  done INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX updates_created ON updates (created_at);
CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
