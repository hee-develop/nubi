/** 테이블 정의. 문자열 상수로 둬서 빌드(tsc)·tsx·vitest 어디서든 파일 읽기 없이 쓴다. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  local_id TEXT,
  vehicle_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  odometer_start_km REAL,
  odometer_end_km REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trips_vehicle_started ON trips (vehicle_id, started_at DESC);

-- speed_kph는 과거 호환용 컬럼이다. 차량 앱은 속도를 수집하지 않으므로 항상 NULL로 남는다.
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
`;

/** local_id 열이 없던 기존 DB를 위한 후속 DDL. SQLite의 UNIQUE 인덱스는 NULL을 여러 개 허용한다. */
export const LOCAL_ID_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_local_id ON trips (local_id)';
