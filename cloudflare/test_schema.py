import sqlite3
import unittest
from pathlib import Path


SCHEMA = Path(__file__).with_name("schema.sql").read_text()

LEGACY_SCHEMA = """
CREATE TABLE relay_state (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  is_on INTEGER NOT NULL CHECK (is_on IN (0, 1))
);
INSERT INTO relay_state VALUES (1, 1), (2, 0);

CREATE TABLE relay_settings (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'auto')),
  start_time TEXT NOT NULL DEFAULT '08:00',
  duration_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (duration_minutes BETWEEN 1 AND 1439),
  schedule_enabled INTEGER NOT NULL DEFAULT 0 CHECK (schedule_enabled IN (0, 1))
);
INSERT INTO relay_settings
  (relay_id, mode, start_time, duration_minutes, schedule_enabled)
VALUES (1, 'auto', '07:30', 25, 1), (2, 'manual', '08:00', 30, 0);

CREATE TABLE device_poll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_poll_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO device_poll_state VALUES (1, 123456789);

CREATE TABLE skipped_schedule (
  relay_id INTEGER PRIMARY KEY CHECK (relay_id IN (1, 2)),
  occurrence_start INTEGER NOT NULL
);
INSERT INTO skipped_schedule VALUES (1, 987654321);

CREATE TABLE device_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 240)
);
INSERT INTO device_logs (created_at, level, message)
VALUES (123456789, 'info', 'existing log');
"""


class SchemaMigrationTests(unittest.TestCase):
    def setUp(self):
        self.database = sqlite3.connect(":memory:")
        self.database.execute("PRAGMA foreign_keys = ON")

    def tearDown(self):
        self.database.close()

    def test_migration_preserves_existing_state_and_is_repeatable(self):
        self.database.executescript(LEGACY_SCHEMA)

        self.database.executescript(SCHEMA)
        self.database.executescript(SCHEMA)

        self.assertEqual(
            self.database.execute(
                "SELECT relay_id, is_on FROM relay_state ORDER BY relay_id",
            ).fetchall(),
            [(1, 1), (2, 0)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT relay_id, name FROM relay_metadata ORDER BY relay_id",
            ).fetchall(),
            [(1, "Relay 1"), (2, "Relay 2")],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT relay_id, start_time, duration_minutes FROM relay_schedules",
            ).fetchall(),
            [(1, "07:30", 25)],
        )
        self.assertEqual(
            self.database.execute(
                "SELECT relay_id, schedule_id, occurrence_start "
                "FROM skipped_schedule_occurrences",
            ).fetchall(),
            [(1, 1, 987654321)],
        )
        self.assertEqual(
            self.database.execute("SELECT message FROM device_logs").fetchall(),
            [("existing log",)],
        )

    def test_schedule_constraints_and_skip_cleanup(self):
        self.database.executescript(SCHEMA)
        self.database.execute(
            "INSERT INTO relay_schedules (relay_id, start_time, duration_minutes) "
            "VALUES (1, '07:30', 25)",
        )
        schedule_id = self.database.execute(
            "SELECT id FROM relay_schedules WHERE relay_id = 1",
        ).fetchone()[0]
        self.database.execute(
            "INSERT INTO skipped_schedule_occurrences "
            "(relay_id, schedule_id, occurrence_start) VALUES (1, ?, 987654321)",
            (schedule_id,),
        )

        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute(
                "INSERT INTO relay_schedules (relay_id, start_time, duration_minutes) "
                "VALUES (1, '07:30', 25)",
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.execute(
                "INSERT INTO relay_schedules (relay_id, start_time, duration_minutes) "
                "VALUES (1, '08:00', 1440)",
            )

        self.database.execute("DELETE FROM relay_schedules WHERE id = ?", (schedule_id,))
        self.assertEqual(
            self.database.execute(
                "SELECT COUNT(*) FROM skipped_schedule_occurrences",
            ).fetchone()[0],
            0,
        )


if __name__ == "__main__":
    unittest.main()
