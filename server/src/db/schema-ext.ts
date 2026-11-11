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

/** 확장 스키마를 만든다. 여러 번 불러도 같다. */
export const ensureExtSchema = (db: Db) => {
  db.exec(SCHEMA_FADE);
  db.exec(SCHEMA_AUTH);
};
