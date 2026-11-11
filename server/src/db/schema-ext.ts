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

/** 확장 스키마를 만든다. 여러 번 불러도 같다. */
export const ensureExtSchema = (db: Db) => {
  db.exec(SCHEMA_FADE);
};
