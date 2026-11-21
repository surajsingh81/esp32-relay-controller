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

CREATE TABLE IF NOT EXISTS relay_metadata (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 24)
);

INSERT OR IGNORE INTO relay_metadata (relay_id, name) VALUES
  (1, 'Relay 1'),
  (2, 'Relay 2');

CREATE TABLE IF NOT EXISTS relay_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relay_id INTEGER NOT NULL REFERENCES relay_metadata(relay_id),
  start_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1439),
  UNIQUE (relay_id, start_time)
);

INSERT OR IGNORE INTO relay_schedules (relay_id, start_time, duration_minutes)
SELECT relay_id, start_time, duration_minutes
FROM relay_settings
WHERE schedule_enabled = 1;

CREATE TABLE IF NOT EXISTS device_poll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_poll_ms INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO device_poll_state (id, last_poll_ms) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS skipped_schedule (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  occurrence_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skipped_schedule_occurrences (
  relay_id INTEGER NOT NULL REFERENCES relay_metadata(relay_id),
  schedule_id INTEGER NOT NULL REFERENCES relay_schedules(id) ON DELETE CASCADE,
  occurrence_start INTEGER NOT NULL,
  PRIMARY KEY (relay_id, schedule_id, occurrence_start)
);

INSERT OR IGNORE INTO skipped_schedule_occurrences
  (relay_id, schedule_id, occurrence_start)
SELECT legacy.relay_id, schedule.id, legacy.occurrence_start
FROM skipped_schedule AS legacy
JOIN relay_schedules AS schedule ON schedule.relay_id = legacy.relay_id;

CREATE TABLE IF NOT EXISTS device_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 240)
);
