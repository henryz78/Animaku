CREATE TABLE IF NOT EXISTS account_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_account_users_created_at
  ON account_users(created_at);

CREATE TABLE IF NOT EXISTS account_sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES account_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_sessions_user_id
  ON account_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_account_sessions_expires_at
  ON account_sessions(expires_at);

CREATE TABLE IF NOT EXISTS account_data (
  user_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES account_users(id) ON DELETE CASCADE
);
