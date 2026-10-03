CREATE TABLE IF NOT EXISTS anime_play_counts (
  bangumi_id INTEGER PRIMARY KEY,
  play_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_view_dedup (
  dedup_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stats_view_dedup_expires ON stats_view_dedup(expires_at);

CREATE TABLE IF NOT EXISTS site_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
