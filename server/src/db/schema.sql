CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  odometer_start_km REAL,
  odometer_end_km REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trips_vehicle_started ON trips (vehicle_id, started_at DESC);

CREATE TABLE IF NOT EXISTS trip_points (
  trip_id TEXT NOT NULL REFERENCES trips (id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  heading_deg REAL,
  confidence REAL,
  speed_kph REAL,
  gear TEXT,
  PRIMARY KEY (trip_id, seq)
);
