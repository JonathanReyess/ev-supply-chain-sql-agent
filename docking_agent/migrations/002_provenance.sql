PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS dock_events (
  event_id       TEXT PRIMARY KEY,
  ts_utc         TEXT NOT NULL DEFAULT (datetime('now')),
  location       TEXT NOT NULL,
  door_id        TEXT,
  job_type       TEXT,
  ref_id         TEXT,
  event_type     TEXT NOT NULL,
  reason_code    TEXT,
  reason_detail  TEXT
);

ALTER TABLE dock_assignments ADD COLUMN why_json TEXT;
