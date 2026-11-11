// 월간 재계산(05 계약서 T2, plan 6-4): 도로 DB 스냅샷을 새 달 것으로 바꿀 때 차량별 달린 길이·분모·완료율을 새 DB 기준으로 다시 구한다.
// driven_ways에는 way_id와 커버리지만 있고 길이는 도로 DB에서 조회 때 합치므로(사양 02), 스냅샷을 바꾸면 집계가 새 DB 기준으로 바로 바뀐다.
// 이 스크립트는 그 영향을 미리 보고(기본: 읽기만, DB를 바꾸지 않는다) --apply로 확정한다.
//   node scripts/recompute-coverage.mjs --roads server/data/roads-202612.sqlite [--db server/data/nubi.sqlite] [--apply]
//   --apply: 차량별 월 스냅샷을 coverage_snapshots에 남기고, 새 DB에 있는 way의 snapshot_month를 새 달로 맞춘다.
//            새 DB에 없는 way(OSM에서 사라지거나 id가 바뀐 것)는 지우지 않고 missingWays로 센다(분자에서는 빠진다. 사용자 기록을 잃지 않는다).
// 표준 출력은 JSON(차량별 이전 값(마지막 스냅샷)·새 값·차이). 차량 ID는 해시된 값이고 좌표·VIN은 다루지 않는다.
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** 완주 기준(서버 COVERAGE `COMPLETE_PERCENT`와 같다). */
const COMPLETE_PERCENT = 95;
const RD = 'rd';
const VEHICLE_SET_SQL = '(SELECT ? UNION SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?)';
// server/src/roads/index.ts의 DRIVEN_CTE·ROAD_DRIVEN_CTE와 같은 식이다(테스트가 API 집계와 일치하는지 확인한다).
const DRIVEN_CTE = `d AS (
  SELECT way_id, MAX(coverage) AS cov, MIN(first_driven_at) AS first, MAX(last_driven_at) AS last
  FROM driven_ways WHERE vehicle_id IN ${VEHICLE_SET_SQL} GROUP BY way_id
)`;
const ROAD_DRIVEN_CTE = `r AS (
  SELECT w.road_key, ro.total_length_m AS total,
         MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN d.cov * w.length_m ELSE 0 END), ro.split_length_m)
         + MIN(SUM(CASE WHEN w.eff_length_m < w.length_m THEN 0 ELSE d.cov * w.length_m END), ro.total_length_m - ro.split_length_m) AS driven,
         MAX(d.last) AS last
  FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id JOIN ${RD}.roads ro ON ro.road_key = w.road_key
  GROUP BY w.road_key
)`;

const SNAPSHOT_DDL = `CREATE TABLE IF NOT EXISTS coverage_snapshots (
  vehicle_id TEXT NOT NULL, month TEXT NOT NULL, driven_m REAL NOT NULL, total_m REAL NOT NULL, percent REAL NOT NULL,
  roads_started INTEGER NOT NULL, roads_completed INTEGER NOT NULL, missing_ways INTEGER NOT NULL, computed_at TEXT NOT NULL,
  PRIMARY KEY (vehicle_id, month)
)`;

const round4 = (n) => Math.round(n * 10_000) / 10_000;

/** 차량(별칭은 정본에 합친다)별 집계. [db]에는 도로 DB가 `rd`로 붙어 있어야 한다. */
export const recompute = (db, { month, totalNamedLengthM, apply = false, now = new Date() } = {}) => {
  const canon = new Map();
  for (const { alias_id, vehicle_id } of db.prepare('SELECT alias_id, vehicle_id FROM vehicle_alias').all()) canon.set(alias_id, vehicle_id);
  const vehicles = new Set();
  for (const { vehicle_id } of db.prepare('SELECT DISTINCT vehicle_id FROM driven_ways').all()) vehicles.add(canon.get(vehicle_id) ?? vehicle_id);
  const hasPrev = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'coverage_snapshots'").get();
  const out = [];
  if (apply) {
    db.exec(SNAPSHOT_DDL);
    db.exec('BEGIN'); // 스냅샷 기록과 snapshot_month 갱신은 한 트랜잭션(중간에 실패해도 반쯤 바뀐 채로 남지 않는다)
  }
  try {
  for (const v of [...vehicles].sort()) {
    const driven = db.prepare(`WITH ${DRIVEN_CTE}, ${ROAD_DRIVEN_CTE} SELECT COALESCE(SUM(driven), 0) AS driven FROM r`).get(v, v).driven;
    const counts = db
      .prepare(
        `WITH ${DRIVEN_CTE}, ${ROAD_DRIVEN_CTE}
         SELECT COUNT(*) AS started, COALESCE(SUM(CASE WHEN driven >= total * ? THEN 1 ELSE 0 END), 0) AS completed FROM r`,
      )
      .get(v, v, COMPLETE_PERCENT / 100);
    const missing = db
      .prepare(
        `WITH ${DRIVEN_CTE} SELECT COUNT(*) AS n FROM d WHERE way_id NOT IN (SELECT way_id FROM ${RD}.ways)`,
      )
      .get(v, v).n;
    const prev = hasPrev
      ? db.prepare('SELECT month, driven_m, percent FROM coverage_snapshots WHERE vehicle_id = ? AND month < ? ORDER BY month DESC LIMIT 1').get(v, month)
      : undefined;
    const percent = totalNamedLengthM > 0 ? round4((driven / totalNamedLengthM) * 100) : 0;
    out.push({
      vehicleId: v,
      month,
      drivenM: Math.round(driven),
      totalM: Math.round(totalNamedLengthM),
      percent,
      roadsStarted: counts.started,
      roadsCompleted: counts.completed,
      missingWays: missing,
      previous: prev ? { month: prev.month, drivenM: Math.round(prev.driven_m), percent: prev.percent } : null,
    });
    if (apply) {
      db.prepare(
        `INSERT INTO coverage_snapshots (vehicle_id, month, driven_m, total_m, percent, roads_started, roads_completed, missing_ways, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (vehicle_id, month) DO UPDATE SET driven_m = excluded.driven_m, total_m = excluded.total_m, percent = excluded.percent,
           roads_started = excluded.roads_started, roads_completed = excluded.roads_completed, missing_ways = excluded.missing_ways, computed_at = excluded.computed_at`,
      ).run(v, month, driven, totalNamedLengthM, percent, counts.started, counts.completed, missing, now.toISOString());
    }
  }
  if (apply) db.prepare(`UPDATE driven_ways SET snapshot_month = ? WHERE way_id IN (SELECT way_id FROM ${RD}.ways)`).run(month);
  if (apply) db.exec('COMMIT');
  } catch (e) {
    if (apply) db.exec('ROLLBACK');
    throw e;
  }
  return out;
};

const main = () => {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const roadsPath = arg('--roads');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dbPath = arg('--db') ?? process.env.NUBI_DB ?? resolve(root, 'server/data/nubi.sqlite');
  if (!roadsPath || !existsSync(roadsPath)) {
    console.error('사용법: node scripts/recompute-coverage.mjs --roads <새 도로 DB> [--db <nubi.sqlite>] [--apply]');
    process.exit(2);
  }
  if (!existsSync(dbPath)) {
    console.error(`사용자 DB가 없습니다: ${dbPath}`);
    process.exit(2);
  }
  const apply = args.includes('--apply');
  const db = new DatabaseSync(dbPath);
  db.exec(`ATTACH DATABASE '${pathToFileURL(resolve(roadsPath)).href.replaceAll("'", "''")}?mode=ro' AS ${RD}`);
  const snap = db.prepare(`SELECT month, total_named_length_m FROM ${RD}.snapshot ORDER BY month DESC LIMIT 1`).get();
  if (!snap) {
    console.error('도로 DB에 snapshot 행이 없습니다');
    process.exit(2);
  }
  const rows = recompute(db, { month: snap.month, totalNamedLengthM: snap.total_named_length_m, apply });
  console.log(JSON.stringify({ month: snap.month, apply, totalNamedLengthM: snap.total_named_length_m, vehicles: rows }, null, 2));
  db.close();
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
