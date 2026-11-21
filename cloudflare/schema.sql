CREATE TABLE IF NOT EXISTS relay_state (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  is_on INTEGER NOT NULL CHECK (is_on IN (0, 1))
);

INSERT OR IGNORE INTO relay_state (relay_id, is_on) VALUES (1, 0), (2, 0);

CREATE TABLE IF NOT EXISTS relay_settings (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'auto')),
  start_time TEXT NOT NULL DEFAULT '08:00',
  duration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (duration_minutes BETWEEN 1 AND 1439),
  schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0, 1))
);

INSERT OR IGNORE INTO relay_settings
  (relay_id, mode, start_time, duration_minutes, schedule_enabled)
SELECT relay_id, 'manual', '08:00', 30, 0 FROM relay_state;

CREATE TABLE IF NOT EXISTS device_poll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_poll_ms INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO device_poll_state (id, last_poll_ms) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS skipped_schedule (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  occurrence_start INTEGER NOT NULL
);
