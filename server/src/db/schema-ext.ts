import type { Db } from './index.js';

/**
 * 05 야간 계약서 T2 확장 테이블. `openDb()`가 기본 스키마 뒤에 `ensureExtSchema`를 부른다(전부 IF NOT EXISTS, 열 추가는 마이그레이션).
 * 기존 `driven_ways`에는 열을 더하지 않고 트리거로 파생 기록(되살린 길)을 만든다(매칭 파이프라인을 건드리지 않으려는 것).
 * 트리거는 도로 DB(ATTACH)를 볼 수 없어서 way_id만 남기고, 길이는 조회 때 도로 DB와 합친다.
 * 이 트리거는 **확정 매칭**(`runMatching`의 upsert)만 본다. 실시간 잠정 매칭(T1 `/trips/:id/live`)은 `driven_ways`에 쓰면 안 된다.
 */
const CANON = '(COALESCE((SELECT vehicle_id FROM vehicle_alias WHERE alias_id = NEW.vehicle_id), NEW.vehicle_id))';
/** 같은 차량(정본 + alias) 다른 행들 중 같은 way의 가장 늦은 마지막 시각. */
const OTHER_LAST = `(SELECT MAX(o.last_driven_at) FROM driven_ways o WHERE o.way_id = NEW.way_id AND o.vehicle_id != NEW.vehicle_id AND (o.vehicle_id = ${CANON} OR o.vehicle_id IN (SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ${CANON})))`;

export const SCHEMA_FADE = `
-- 바랜 길을 다시 달려 풀린 기록(사양 05b). 같은 차량(alias 포함)의 이전 마지막 시각보다 365일 넘게 뒤에 다시 달리면 DB 트리거가 한 줄 더한다. cov = 그때 커버리지(되살린 길이 = 유효 길이 x cov).
CREATE TABLE IF NOT EXISTS way_revived (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id TEXT NOT NULL,
  way_id INTEGER NOT NULL,
  revived_at TEXT NOT NULL,
  prev_last_at TEXT NOT NULL,
  cov REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_way_revived_vehicle ON way_revived (vehicle_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_way_revived ON way_revived (vehicle_id, way_id, revived_at);
DROP TRIGGER IF EXISTS trg_driven_ways_revive;
CREATE TRIGGER trg_driven_ways_revive AFTER UPDATE OF last_driven_at ON driven_ways
WHEN julianday(NEW.last_driven_at) - julianday(MAX(OLD.last_driven_at, COALESCE(${OTHER_LAST}, OLD.last_driven_at))) > 365
BEGIN
  INSERT OR IGNORE INTO way_revived (vehicle_id, way_id, revived_at, prev_last_at, cov)
  VALUES (NEW.vehicle_id, NEW.way_id, NEW.last_driven_at, MAX(OLD.last_driven_at, COALESCE(${OTHER_LAST}, OLD.last_driven_at)), NEW.coverage);
END;
-- 같은 차량이 다른 ID(alias 등)로 올린 행이 이미 있고 그것이 오래됐을 때, 새 ID로 처음 들어오는 행(INSERT)도 되살림이다.
DROP TRIGGER IF EXISTS trg_driven_ways_revive_ins;
CREATE TRIGGER trg_driven_ways_revive_ins AFTER INSERT ON driven_ways
WHEN julianday(NEW.last_driven_at) - julianday(${OTHER_LAST}) > 365
BEGIN
  INSERT OR IGNORE INTO way_revived (vehicle_id, way_id, revived_at, prev_last_at, cov)
  VALUES (NEW.vehicle_id, NEW.way_id, NEW.last_driven_at, ${OTHER_LAST}, NEW.coverage);
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

/**
 * 계정·토큰·연결 코드. 토큰과 코드는 평문을 저장하지 않는다(토큰 = SHA-256 해시).
 * scope: api(Bearer API, 180일) | web(웹 페이지 쿠키, 7일, 내리기·삭제 가능) | view(읽기 전용 링크, 24시간). 차량 토큰은 만료 없음(폐기만).
 * revoked_at: 폐기. link_codes.attempts: 그 코드를 건드린 횟수(넘으면 코드를 무효로 한다).
 */
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

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'api',
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_subject ON auth_tokens (kind, subject);

-- 6자리 숫자 코드(5분). kind: pair | guest. 만료·사용된 코드도 1시간 남겨 두고 410(만료)과 404(없음)를 구분한다.
CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * 게스트 세션(plan 9장). 인정 기준은 **트립의 점 시각이 세션 창과 겹치는 부분**이다. 도로는 읽을 때 겹친 점 근처의 차량 인정 way를 `guest_trip_ways`에 계산해 두고
 * (트립 단위 값, 차량 MAX 복사 아님), 시군구는 같은 겹친 점에서 계산한다(`ext/guest-record.ts`).
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

DROP TRIGGER IF EXISTS trg_driven_ways_guest_ins;
DROP TRIGGER IF EXISTS trg_driven_ways_guest_upd;
DROP TABLE IF EXISTS guest_ways;

-- 세션 x 트립 단위의 인정 도로. 창·점 수가 바뀌면 다시 계산한다(guest_trip_cache가 계산 기준을 기억).
CREATE TABLE IF NOT EXISTS guest_trip_ways (
  session_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  way_id INTEGER NOT NULL,
  coverage REAL NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (session_id, trip_id, way_id)
);
CREATE INDEX IF NOT EXISTS idx_guest_trip_ways_session ON guest_trip_ways (session_id);
CREATE TABLE IF NOT EXISTS guest_trip_cache (
  session_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  win_from TEXT NOT NULL,
  win_to TEXT,
  points INTEGER NOT NULL,
  dw_ver TEXT,
  PRIMARY KEY (session_id, trip_id)
);
`;

/** 차량 설정(plan 11-2). 키는 정본 차량 ID. consent_withdrawn_at: 위치정보 동의 철회로 데이터를 지운 시각(기록을 다시 켜면 비운다). */
export const SCHEMA_SETTINGS = `
CREATE TABLE IF NOT EXISTS vehicle_settings (
  vehicle_id TEXT PRIMARY KEY,
  recording_paused INTEGER NOT NULL DEFAULT 0,
  home_region TEXT,
  stats_opt_in INTEGER NOT NULL DEFAULT 1,
  drive_map INTEGER NOT NULL DEFAULT 1,
  hide_home_in_cards INTEGER NOT NULL DEFAULT 1,
  consent_withdrawn_at TEXT,
  updated_at TEXT NOT NULL
);
`;

/** 공유 카드(plan 10-1). 만들 때 비식별 SVG를 렌더해 PNG로 1회 변환해 저장한다. 공개 경로는 PNG만 내보낸다(svg는 내부 보관). */
export const SCHEMA_SHARE = `
CREATE TABLE IF NOT EXISTS share_cards (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  svg TEXT NOT NULL,
  png BLOB,
  meta_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_cards_vehicle ON share_cards (vehicle_id, created_at);
`;

/** 지역 소개 TourAPI 응답 캐시(plan 10-2). cache_key = 시군구·기준 위치(0.01도)·종류, fetched_at(ms)에서 24시간. */
export const SCHEMA_INTRO = `
CREATE TABLE IF NOT EXISTS intro_cache (
  cache_key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  body_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS intro_calls (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
`;

/** B2B 코스(plan 13-7)와 완주 인증서(추측 불가 id, 발급 시점의 코스 정보를 스냅샷으로 보관). */
export const SCHEMA_COURSES = `
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region_code TEXT NOT NULL,
  road_keys_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  cert_no TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (course_id, vehicle_id)
);
`;

const addColumn = (db: Db, table: string, column: string, ddl: string) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
};

/** 확장 스키마를 만들고(여러 번 불러도 같다) 앞 버전 테이블에 열을 더한다. */
export const ensureExtSchema = (db: Db) => {
  db.exec(SCHEMA_FADE.replace(/CREATE UNIQUE INDEX IF NOT EXISTS uq_way_revived[^;]*;/, ''));
  addColumn(db, 'way_revived', 'cov', 'REAL NOT NULL DEFAULT 1');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_way_revived ON way_revived (vehicle_id, way_id, revived_at)');
  db.exec(SCHEMA_AUTH);
  addColumn(db, 'auth_tokens', 'scope', "TEXT NOT NULL DEFAULT 'api'");
  addColumn(db, 'auth_tokens', 'expires_at', 'TEXT');
  addColumn(db, 'auth_tokens', 'revoked_at', 'TEXT');
  addColumn(db, 'link_codes', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  // 앞 버전의 계정 토큰(만료 없음)에 만료를 채운다: 생성 후 180일(API scope)
  db.exec("UPDATE auth_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(created_at) + 180) WHERE kind = 'account' AND expires_at IS NULL");
  db.exec(SCHEMA_GUEST);
  addColumn(db, 'guest_trip_cache', 'dw_ver', 'TEXT');
  db.exec(SCHEMA_SETTINGS);
  db.exec(SCHEMA_SHARE);
  addColumn(db, 'share_cards', 'png', 'BLOB');
  db.exec(SCHEMA_INTRO);
  addColumn(db, 'intro_cache', 'fetched_at', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(SCHEMA_COURSES);
};
