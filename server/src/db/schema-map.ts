import type { Db } from './index.js';

/** 차량 지도 트랙(T1) 테이블. 주행 중 잠정 매칭 결과만 담고, 완료율·도감(driven_ways·visited_regions)에는 절대 쓰지 않는다. */
export const MAP_SCHEMA = `
-- 트립별 잠정 매칭 진행 상태. up_to_seq: 잠정 매칭에 쓴 마지막 점의 seq. 트립을 지우면(데이터 삭제 등) 함께 지워진다.
CREATE TABLE IF NOT EXISTS trip_live (
  trip_id TEXT PRIMARY KEY REFERENCES trips (id) ON DELETE CASCADE,
  up_to_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- 잠정으로 인정한 way. is_new: 매칭 시점에 그 차량이 한 번도 인정받지 못한 way였다(첫 인정 순간의 스냅샷이라 트립 종료 뒤에도 바뀌지 않는다).
CREATE TABLE IF NOT EXISTS trip_live_ways (
  trip_id TEXT NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  way_id INTEGER NOT NULL,
  is_new INTEGER NOT NULL,
  PRIMARY KEY (trip_id, way_id)
);
`;

const needsCascade = (db: Db, table: string) => {
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[];
  return fks.some((f) => f.table === 'trips' && f.on_delete.toUpperCase() !== 'CASCADE');
};

/**
 * 지도 테이블을 만든다. 첫 배포 때 `ON DELETE CASCADE` 없이 만들어진 기존 DB는 테이블을 다시 만들어 옮긴다
 * (그대로 두면 트립 삭제가 FK 오류로 통째 실패한다). 행은 보존한다.
 */
export const initMapSchema = (db: Db) => {
  const stale = ['trip_live', 'trip_live_ways'].filter((t) => {
    const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    return exists && needsCascade(db, t);
  });
  if (stale.length === 0) {
    db.exec(MAP_SCHEMA);
    return;
  }
  db.exec('BEGIN');
  try {
    for (const t of stale) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_old`);
    db.exec(MAP_SCHEMA);
    for (const t of stale) {
      db.exec(`INSERT OR IGNORE INTO ${t} SELECT * FROM ${t}_old WHERE trip_id IN (SELECT id FROM trips)`);
      db.exec(`DROP TABLE ${t}_old`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};
