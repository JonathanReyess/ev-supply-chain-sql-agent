PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS dock_doors (
  door_id        TEXT PRIMARY KEY,
  location       TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dock_resources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  location       TEXT NOT NULL,
  slot_start_utc TEXT NOT NULL,
  slot_end_utc   TEXT NOT NULL,
  crews          INTEGER NOT NULL,
  forklifts      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_trucks (
  truck_id       TEXT PRIMARY KEY,
  po_id          TEXT,
  location       TEXT NOT NULL,
  eta_utc        TEXT NOT NULL,
  unload_min     INTEGER NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'scheduled'
);

CREATE TABLE IF NOT EXISTS outbound_loads (
  load_id        TEXT PRIMARY KEY,
  location       TEXT NOT NULL,
  cutoff_utc     TEXT NOT NULL,
  load_min       INTEGER NOT NULL,
  carrier        TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'planned'
);

CREATE TABLE IF NOT EXISTS yard_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  location       TEXT NOT NULL,
  truck_id       TEXT,
  position       INTEGER,
  created_utc    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dock_assignments (
  assignment_id  TEXT PRIMARY KEY,
  location       TEXT NOT NULL,
  door_id        TEXT NOT NULL,
  job_type       TEXT NOT NULL,
  ref_id         TEXT NOT NULL,
  start_utc      TEXT NOT NULL,
  end_utc        TEXT NOT NULL,
  crew           TEXT,
  created_utc    TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'scheduled',
  FOREIGN KEY (door_id) REFERENCES dock_doors(door_id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_loc_time
  ON dock_assignments(location, start_utc, end_utc);

CREATE INDEX IF NOT EXISTS idx_inbound_eta
  ON inbound_trucks(location, eta_utc);

CREATE INDEX IF NOT EXISTS idx_outbound_cutoff
  ON outbound_loads(location, cutoff_utc);
