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

-- 차량 앱이 UUID로 대체해 쓰던 차량 ID(alias_id)를 나중에 받은 서버 발급 ID(vehicle_id)에 잇는다. 한 단계만 따라간다.
CREATE TABLE IF NOT EXISTS vehicle_alias (
  alias_id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vehicle_alias_vehicle ON vehicle_alias (vehicle_id);

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

-- 맵매칭 작업(사양 02 4장). queued_at은 24시간 재시도 한도를 재려고 더한 열이다(가안).
CREATE TABLE IF NOT EXISTS trip_matching (
  trip_id TEXT PRIMARY KEY REFERENCES trips (id),
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_json TEXT
);

-- 인정된 way. 차량별 최댓값 커버리지. 도로 DB(ODbL 파생)는 별도 파일이라 여기에는 way_id만 둔다.
CREATE TABLE IF NOT EXISTS driven_ways (
  vehicle_id TEXT NOT NULL,
  way_id INTEGER NOT NULL,
  coverage REAL NOT NULL,
  first_driven_at TEXT NOT NULL,
  last_driven_at TEXT NOT NULL,
  trip_id_first TEXT NOT NULL,
  snapshot_month TEXT NOT NULL,
  PRIMARY KEY (vehicle_id, way_id)
);
`;

/** local_id 열이 없던 기존 DB를 위한 후속 DDL. SQLite의 UNIQUE 인덱스는 NULL을 여러 개 허용한다. */
export const LEGACY_LOCAL_ID_INDEX = 'idx_trips_local_id';

/** localId는 차량 앱이 만든 UUID지만 서버는 믿지 않는다. 다른 차량의 localId와 겹쳐도 서로 영향이 없도록 (vehicle_id, local_id)로 유일하게 한다. */
export const LOCAL_ID_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_vehicle_local_id ON trips (vehicle_id, local_id)';
