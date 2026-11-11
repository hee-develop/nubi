import type { Db } from './index.js';

/**
 * 05 야간 계약서 T2 확장 테이블. `ensureExtSchema`가 `extRoutes()`를 만들 때 한 번 실행한다(전부 IF NOT EXISTS).
 * 기존 `driven_ways`에는 열을 더하지 않고 트리거로 파생 기록(되살린 길·게스트 귀속)을 만든다(매칭 파이프라인을 건드리지 않으려는 것).
 * 트리거는 도로 DB(ATTACH)를 볼 수 없어서 way_id만 남기고, 길이는 조회 때 도로 DB와 합친다.
 */
export const SCHEMA_FADE = `
-- 바랜 길이 다시 달려 풀린 기록(사양 05b). 다시 달린 트립의 마지막 시각이 이전 마지막 시각보다 365일 넘게 뒤일 때 DB 트리거가 한 줄 더한다.
CREATE TABLE IF NOT EXISTS way_revived (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id TEXT NOT NULL,
  way_id INTEGER NOT NULL,
  revived_at TEXT NOT NULL,
  prev_last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_way_revived_vehicle ON way_revived (vehicle_id);
CREATE TRIGGER IF NOT EXISTS trg_driven_ways_revive AFTER UPDATE OF last_driven_at ON driven_ways
WHEN julianday(NEW.last_driven_at) - julianday(OLD.last_driven_at) > 365
BEGIN
  INSERT INTO way_revived (vehicle_id, way_id, revived_at, prev_last_at) VALUES (NEW.vehicle_id, NEW.way_id, NEW.last_driven_at, OLD.last_driven_at);
END;

-- 월간 재계산 스크립트(scripts/recompute-coverage.mjs)가 남기는 차량별 월 스냅샷 기록.
CREATE TABLE IF NOT EXISTS coverage_snapshots (
  vehicle_id TEXT NOT NULL,
  month TEXT NOT NULL,
  driven_m REAL NOT NULL,
  total_m REAL NOT NULL,
  percent REAL NOT NULL,
  roads_started INTEGER NOT NULL,
  roads_completed INTEGER NOT NULL,
  missing_ways INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (vehicle_id, month)
);
`;

/** 계정·토큰·연결 코드(차주 연결 pair, 게스트). 토큰과 코드는 평문을 저장하지 않는다(토큰 = SHA-256 해시, 코드는 5분 뒤 의미 없음). */
export const SCHEMA_AUTH = `
-- kind: owner(차주, 차 1대에 1명) | guest(게스트). owner의 vehicle_id는 서버 발급 정본 차량 ID.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  vehicle_id TEXT,
  nickname TEXT,
  created_at TEXT NOT NULL,
  consent_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_owner_vehicle ON accounts (vehicle_id) WHERE kind = 'owner';

-- kind: vehicle(차량 앱이 register로 받은 토큰, subject = 차량 ID) | account(subject = 계정 ID). 해시만 저장한다.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_subject ON auth_tokens (kind, subject);

-- 6자리 숫자 코드(5분). kind: pair | guest. 만료·사용된 코드도 1시간 남겨 두고 410(만료)과 404(없음)를 구분한다.
CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

/**
 * 게스트 세션(plan 9장). 세션이 열린 동안의 그 차량 트립을 게스트에게도 인정한다. 도로(way)는 DB 트리거가 `driven_ways` 변경을 보고 `guest_ways`에 옮겨 담고
 * (매칭 파이프라인은 건드리지 않는다), 시군구는 세션 시간 창의 트립(`trip_matching.result_json.regions`·`region_events`)에서 조회 때 계산한다.
 * end_reason: guest(내리기) | owner(모두 내리기) | idle(마지막 트립 종료 후 12시간) | own_trip(게스트가 자기 차에서 트립 시작) | unpaired | deleted.
 */
export const SCHEMA_GUEST = `
CREATE TABLE IF NOT EXISTS guest_sessions (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  nickname TEXT,
  consent_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_vehicle ON guest_sessions (vehicle_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_account ON guest_sessions (account_id);

CREATE TABLE IF NOT EXISTS guest_ways (
  session_id TEXT NOT NULL,
  way_id INTEGER NOT NULL,
  coverage REAL NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (session_id, way_id)
);

CREATE TRIGGER IF NOT EXISTS trg_driven_ways_guest_ins AFTER INSERT ON driven_ways
BEGIN
  INSERT INTO guest_ways (session_id, way_id, coverage, first_at, last_at)
  SELECT s.id, NEW.way_id, NEW.coverage, NEW.first_driven_at, NEW.last_driven_at FROM guest_sessions s
  WHERE s.deleted_at IS NULL
    AND s.vehicle_id IN (NEW.vehicle_id, COALESCE((SELECT vehicle_id FROM vehicle_alias WHERE alias_id = NEW.vehicle_id), NEW.vehicle_id))
    AND NEW.last_driven_at >= s.started_at AND (s.ended_at IS NULL OR NEW.last_driven_at <= s.ended_at)
  ON CONFLICT (session_id, way_id) DO UPDATE SET coverage = MAX(coverage, excluded.coverage), first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_driven_ways_guest_upd AFTER UPDATE OF last_driven_at, coverage ON driven_ways
WHEN NEW.last_driven_at > OLD.last_driven_at OR NEW.coverage > OLD.coverage
BEGIN
  INSERT INTO guest_ways (session_id, way_id, coverage, first_at, last_at)
  SELECT s.id, NEW.way_id, NEW.coverage, NEW.last_driven_at, NEW.last_driven_at FROM guest_sessions s
  WHERE s.deleted_at IS NULL
    AND s.vehicle_id IN (NEW.vehicle_id, COALESCE((SELECT vehicle_id FROM vehicle_alias WHERE alias_id = NEW.vehicle_id), NEW.vehicle_id))
    AND NEW.last_driven_at >= s.started_at AND (s.ended_at IS NULL OR NEW.last_driven_at <= s.ended_at)
  ON CONFLICT (session_id, way_id) DO UPDATE SET coverage = MAX(coverage, excluded.coverage), first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at);
END;
`;

/** 확장 스키마를 만든다. 여러 번 불러도 같다. */
export const ensureExtSchema = (db: Db) => {
  db.exec(SCHEMA_FADE);
  db.exec(SCHEMA_AUTH);
  db.exec(SCHEMA_GUEST);
};
