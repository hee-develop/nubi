/** 맵매칭 결과 처리(사양 02 4장): 합산 → 도로 DB 조회 → 오도미터 대조 → low_confidence → 인정 → driven_ways upsert → result_json. */
import type { Db } from '../db/index.js';
import { findWays, nationalCoverage, roundPercent, type Roads } from '../roads/index.js';
import type { RegionsResult } from '../regions/judge.js';
import { haversineM } from '../routes/trips.js';
import { traceAttributes, type TraceDeps } from './valhalla.js';

export const MIN_POINTS = 20;
export const MIN_DISTANCE_M = 100;
/** 인정: 커버리지 ≥ 0.7 또는 매칭 길이 ≥ 500m(가안). */
export const MIN_COVERAGE = 0.7;
export const MIN_MATCHED_M = 500;
export const MAX_UNMATCHED_RATIO = 0.5;

export type Outcome = 'counted' | 'skipped' | 'suspect' | 'low_confidence';

export type MatchResult = {
  outcome: Outcome;
  /** 인정하지 않은 사유: too_short | odometer_mismatch | low_confidence. */
  reason?: string;
  newWays: number;
  /**
   * 이번 주행의 **전국 달린 길이 증가분**(km): 매칭 전후 집계(묶음별 상한·분리 구간 1/2 적용 후)의 차이(사양 2장).
   * 실제 way 길이 합이 아니다. `nationalPercentAfter − Before ≈ newKm / 분모(km) × 100`.
   */
  newKm: number;
  roadsTouched: string[];
  nationalPercentBefore: number;
  nationalPercentAfter: number;
  suspect: boolean;
  /** 도로 DB에 없는 way(service 등 제외 등급, pbf 버전 차이). */
  ignoredWays: number;
  /** 이름·번호가 없어 분자·분모에서 제외한 way. */
  ignoredUnnamed: number;
  matchedKm?: number;
  unmatchedRatio?: number;
  /** 시군구 판정(사양 03 4장). 매칭과 분리된 작업이라 매칭이 끝난 시점에는 `'pending'`이고 워커가 완료 시 결과로 갱신한다. 지역 판정을 안 쓰거나 의심(suspect) 트립이면 없다. */
  regions?: RegionsResult | 'pending' | 'failed';
};

type TripRow = {
  id: string;
  vehicle_id: string;
  started_at: string;
  ended_at: string | null;
  odometer_start_km: number | null;
  odometer_end_km: number | null;
};
type PointRow = { lat: number; lon: number; ts: string };

/** 트립 차량의 대표 ID: alias(UUID)면 서버 발급 ID로 올린다. 집계는 이 ID와 그 alias 전체를 한 차량으로 본다. */
export const canonicalVehicleId = (db: Db, vehicleId: string) =>
  (db.prepare('SELECT vehicle_id FROM vehicle_alias WHERE alias_id = ?').get(vehicleId) as { vehicle_id: string } | undefined)
    ?.vehicle_id ?? vehicleId;

const pathLengthM = (pts: PointRow[]) => {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1]!.lat, pts[i - 1]!.lon, pts[i]!.lat, pts[i]!.lon);
  return d;
};

const emptyResult = (outcome: Outcome, reason: string | undefined, percent: number, ignored = 0, ignoredUnnamed = 0): MatchResult => ({
  outcome,
  ...(reason ? { reason } : {}),
  newWays: 0,
  newKm: 0,
  roadsTouched: [],
  nationalPercentBefore: percent,
  nationalPercentAfter: percent,
  suspect: outcome === 'suspect',
  ignoredWays: ignored,
  ignoredUnnamed,
});

/** 오도미터 대조(사양 4장 4): 오도미터가 양수로 늘었는데 GPS 길이가 `odoDelta × 1.1 + 1km`를 넘으면 의심(카페리·견인). null·0·감소면 건너뛴다. */
export const isOdometerMismatch = (distanceM: number, startKm: number | null, endKm: number | null) => {
  if (startKm == null || endKm == null) return false;
  const deltaKm = endKm - startKm;
  if (!(deltaKm > 0)) return false;
  return distanceM > deltaKm * 1000 * 1.1 + 1000;
};

/**
 * 한 트립을 매칭한다. 결과가 정해지면 [finish]를 부른다. 인정된 way를 저장하는 경우 [finish]는 `driven_ways` 갱신과 **같은 트랜잭션** 안에서 불려
 * (워커가 거기서 `trip_matching`을 done으로 바꾼다) 한쪽만 반영되는 중간 상태가 남지 않는다.
 */
export const runMatching = async (
  db: Db,
  roads: Roads,
  tripId: string,
  deps: TraceDeps,
  finish: (result: MatchResult) => void,
): Promise<MatchResult> => {
  const done = (r: MatchResult) => {
    finish(r);
    return r;
  };
  /** 트랜잭션 밖에서 끝나는 결과(짧은 트립·low_confidence)도 finish(done 표시 + 지역 작업 등록)를 한 트랜잭션에 묶는다. */
  const doneTx = (r: MatchResult) => {
    db.exec('BEGIN');
    try {
      finish(r);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return r;
  };
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as TripRow | undefined;
  if (!trip) throw new Error('trip 없음');
  const vehicle = canonicalVehicleId(db, trip.vehicle_id);
  const points = db.prepare('SELECT lat, lon, ts FROM trip_points WHERE trip_id = ? ORDER BY seq').all(tripId) as PointRow[];
  const before = roundPercent(nationalCoverage(db, roads, vehicle).percent);
  const distanceM = pathLengthM(points);

  if (points.length < MIN_POINTS || distanceM < MIN_DISTANCE_M) return doneTx(emptyResult('skipped', 'too_short', before));
  if (isOdometerMismatch(distanceM, trip.odometer_start_km, trip.odometer_end_km))
    return done(emptyResult('suspect', 'odometer_mismatch', before));

  const trace = await traceAttributes(points, deps);
  const totalPoints = trace.matchedPoints + trace.unmatchedPoints;
  const unmatchedRatio = totalPoints > 0 ? trace.unmatchedPoints / totalPoints : 1;
  const matchedKm = [...trace.wayLengthsM.values()].reduce((a, b) => a + b, 0) / 1000;
  if (unmatchedRatio > MAX_UNMATCHED_RATIO) {
    return doneTx({ ...emptyResult('low_confidence', 'low_confidence', before), matchedKm, unmatchedRatio });
  }

  const ways = findWays(db, [...trace.wayLengthsM.keys()]);
  let ignoredWays = 0;
  let ignoredUnnamed = 0;
  const recognized: { wayId: number; roadKey: string; coverage: number; lengthM: number }[] = [];
  for (const [wayId, matchedM] of trace.wayLengthsM) {
    const w = ways.get(wayId);
    if (!w) {
      ignoredWays++;
      continue;
    }
    if (w.road_key.startsWith('unnamed:')) {
      ignoredUnnamed++;
      continue;
    }
    // 같은 way를 왕복해도 매칭 길이는 way 길이로 상한(사양 6-3).
    const coverage = Math.min(1, matchedM / w.length_m);
    if (coverage >= MIN_COVERAGE || matchedM >= MIN_MATCHED_M)
      recognized.push({ wayId, roadKey: w.road_key, coverage, lengthM: w.length_m });
  }

  const lastAt = trip.ended_at ?? points.at(-1)!.ts;
  const firstAt = trip.started_at;
  let newWays = 0;
  db.exec('BEGIN');
  try {
    const beforeM = nationalCoverage(db, roads, vehicle).drivenM;
    const old = new Map<number, number>();
    const getOld = db.prepare(
      `SELECT MAX(coverage) AS c FROM driven_ways WHERE way_id = ? AND vehicle_id IN (SELECT ? UNION SELECT alias_id FROM vehicle_alias WHERE vehicle_id = ?)`,
    );
    for (const r of recognized) old.set(r.wayId, (getOld.get(r.wayId, vehicle, vehicle) as { c: number | null }).c ?? 0);
    // 커버리지는 줄지 않는다(MAX). 처음 칠한 시각이 더 이른 값으로 바뀔 때만 그 트립을 trip_id_first로 한다.
    const upsert = db.prepare(
      `INSERT INTO driven_ways (vehicle_id, way_id, coverage, first_driven_at, last_driven_at, trip_id_first, snapshot_month)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (vehicle_id, way_id) DO UPDATE SET
         coverage = MAX(coverage, excluded.coverage),
         trip_id_first = CASE WHEN excluded.first_driven_at < first_driven_at THEN excluded.trip_id_first ELSE trip_id_first END,
         first_driven_at = MIN(first_driven_at, excluded.first_driven_at),
         last_driven_at = MAX(last_driven_at, excluded.last_driven_at),
         snapshot_month = excluded.snapshot_month`,
    );
    for (const r of recognized) {
      if ((old.get(r.wayId) ?? 0) === 0) newWays++;
      upsert.run(trip.vehicle_id, r.wayId, r.coverage, firstAt, lastAt, tripId, roads.month);
    }
    const after = nationalCoverage(db, roads, vehicle);
    const result: MatchResult = {
      outcome: 'counted',
      newWays,
      // 매칭 전후 집계 차이(사양 2장). m 단위로 반올림해 km로 낸다.
      newKm: Math.max(0, Math.round(after.drivenM - beforeM)) / 1000,
      roadsTouched: [...new Set(recognized.map((r) => r.roadKey))],
      nationalPercentBefore: roundPercent(roads.totalNamedLengthM > 0 ? (beforeM / roads.totalNamedLengthM) * 100 : 0),
      nationalPercentAfter: roundPercent(after.percent),
      suspect: false,
      ignoredWays,
      ignoredUnnamed,
      matchedKm: Math.round(matchedKm * 1000) / 1000,
      unmatchedRatio: Math.round(unmatchedRatio * 1000) / 1000,
    };
    finish(result);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};
