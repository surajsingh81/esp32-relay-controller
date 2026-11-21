CREATE TABLE IF NOT EXISTS relay_state (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  is_on INTEGER NOT NULL CHECK (is_on IN (0, 1))
);

INSERT OR IGNORE INTO relay_state (relay_id, is_on) VALUES (1, 0), (2, 0);
