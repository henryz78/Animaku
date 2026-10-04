CREATE TABLE IF NOT EXISTS bangumi_data_mapping (
  bangumi_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  sites TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bgm_mapping_updated
  ON bangumi_data_mapping(updated_at);
