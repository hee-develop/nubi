import { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { ATTRIBUTION, DRIVEN_CTE, nationalCoverage, RD, ROAD_DRIVEN_CTE, roundPercent, VEHICLE_SET_SQL, type Roads } from '../roads/index.js';
import { isFaded } from '../shared/fade.js';

/** 완주 기준(결정): 도로 완주율 95% 이상. */
export const COMPLETE_PERCENT = 95;
/** '거의 다 달린 도로'의 하한(완주율 %, 상한은 완주 기준). */
export const ALMOST_PERCENT = 80;
export const MAX_SEGMENTS = 5_000;
export const MAX_BBOX_SPAN_DEG = 1;
const MAX_ROADS_LIMIT = 200;
const MAX_NAMES = 20;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 매칭 실패 사유는 분류와 코드(`retryable:network`·`permanent:http_400`)만 내보낸다. 메시지는 서버 로그에만 남는다. */
const publicError = (error: string): string => {
  const m = /^(retryable|permanent):([a-z0-9_]+)$/.exec(error);
  if (m) return error;
  return `${error.startsWith('permanent') ? 'permanent' : 'retryable'}:unknown`;
};

/** 사양 5장: 조회 API 4개와 매칭 상태. 모든 응답에 snapshotMonth·attribution을 싣는다. */
/** [now]는 바램(`faded`) 판정 시계다(생략하면 Date.now). */
export const coverageRoutes = (db: Db, getRoads: () => Roads | null, now: () => number = Date.now) => {
  const base = (roads: Roads | null) => ({ snapshotMonth: roads?.month ?? null, attribution: ATTRIBUTION });
  /** 되살린 길이(m): `way_revived` 기록(DB 트리거)을 도로 DB의 유효 길이와 합친다. */
  const revivedM = (vehicleId: string) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(w.eff_length_m * r.cov), 0) AS m FROM way_revived r JOIN ${RD}.ways w ON w.way_id = r.way_id
           WHERE r.vehicle_id IN ${VEHICLE_SET_SQL}`,
        )
        .get(vehicleId, vehicleId) as { m: number }
    ).m;
  const unavailable = () => ({ error: 'roads_db_unavailable' as const, snapshotMonth: null, attribution: ATTRIBUTION });

  return new Hono()
    .get('/trips/:tripId/matching', (c) => {
      const row = db
        .prepare('SELECT status, attempts, error, started_at, finished_at, result_json FROM trip_matching WHERE trip_id = ?')
        .get(c.req.param('tripId')) as
        | {
            status: string;
            attempts: number;
            error: string | null;
            started_at: string | null;
            finished_at: string | null;
            result_json: string | null;
          }
        | undefined;
      if (!row) return c.json({ error: 'not_found' as const, ...base(getRoads()) }, 404);
      return c.json(
        {
          status: row.status,
          attempts: row.attempts,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          ...(row.result_json ? { result: JSON.parse(row.result_json) as Record<string, unknown> } : {}),
          ...(row.error ? { error: publicError(row.error) } : {}),
          ...base(getRoads()),
        },
        200,
      );
    })
    .get('/coverage/summary', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' as const, ...base(getRoads()) }, 400);
      const roads = getRoads();
      if (!roads) return c.json(unavailable(), 503);
      const nat = nationalCoverage(db, roads, vehicleId);
      const counts = db
        .prepare(
          `WITH ${DRIVEN_CTE}, ${ROAD_DRIVEN_CTE}
           SELECT COUNT(*) AS started, COALESCE(SUM(CASE WHEN driven >= total * ? THEN 1 ELSE 0 END), 0) AS completed FROM r`,
        )
        .get(vehicleId, vehicleId, COMPLETE_PERCENT / 100) as { started: number; completed: number };
      return c.json(
        {
          ...base(roads),
          nationalPercent: roundPercent(nat.percent),
          drivenKm: round2(nat.drivenM / 1000),
          totalKm: round2(roads.totalNamedLengthM / 1000),
          roadsCompleted: counts.completed,
          roadsStarted: counts.started,
          /** 바랜 길을 다시 달려 되살린 거리(km). 완료율에는 영향이 없다(plan 8장). */
          revivedKm: round2(revivedM(vehicleId) / 1000),
        },
        200,
      );
    })
    .get('/coverage/roads', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' as const, ...base(getRoads()) }, 400);
      const roads = getRoads();
      if (!roads) return c.json(unavailable(), 503);
      const sort = c.req.query('sort') ?? 'percent';
      if (!['percent', 'recent', 'length'].includes(sort)) return c.json({ error: 'invalid_sort' as const, ...base(roads) }, 400);
      const limitRaw = Number(c.req.query('limit') ?? 50);
      const offsetRaw = Number(c.req.query('offset') ?? 0);
      const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_ROADS_LIMIT) : 50;
      const offset = Number.isInteger(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
      const filter = c.req.query('filter') ?? 'all';
      if (!['all', 'almost'].includes(filter)) return c.json({ error: 'invalid_filter' as const, ...base(roads) }, 400);
      const q = (c.req.query('q') ?? '').trim();
      const order = { percent: 'pct DESC, driven DESC', recent: 'r.last DESC, driven DESC', length: 'driven DESC' }[sort];
      // 검색: 표시 이름과 names_json(그 도로를 이루는 way의 거리명)을 함께 본다. 도로 DB는 읽기 전용이라 LIKE 대신 instr로 와일드카드 걱정을 없앤다.
      // filter=almost: 거의 다 달린 도로(완주율 80% 이상 95% 미만, plan 11-1).
      const conds = [
        ...(q ? ['(instr(ro.display_name, ?) > 0 OR instr(ro.names_json, ?) > 0)'] : []),
        ...(filter === 'almost' ? [`r.driven / ro.total_length_m >= ${ALMOST_PERCENT / 100} AND r.driven / ro.total_length_m < ${COMPLETE_PERCENT / 100}`] : []),
      ];
      const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      const args: (string | number)[] = [vehicleId, vehicleId, ...(q ? [q, q] : [])];
      const withCtes = `WITH ${DRIVEN_CTE}, ${ROAD_DRIVEN_CTE}`;
      const total = (
        db.prepare(`${withCtes} SELECT COUNT(*) AS n FROM r JOIN ${RD}.roads ro ON ro.road_key = r.road_key ${where}`).get(...args) as {
          n: number;
        }
      ).n;
      const rows = db
        .prepare(
          `${withCtes}
             SELECT ro.road_key, ro.display_name, ro.highway_major, ro.total_length_m, ro.names_json, r.driven, r.last, r.driven / ro.total_length_m AS pct
             FROM r JOIN ${RD}.roads ro ON ro.road_key = r.road_key ${where}
             ORDER BY ${order}, ro.road_key LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset) as {
        road_key: string;
        display_name: string;
        highway_major: string;
        total_length_m: number;
        names_json: string;
        driven: number;
        last: string;
        pct: number;
      }[];
      const items = rows.map((r) => {
        const all = JSON.parse(r.names_json) as string[];
        // 검색어에 걸린 거리명을 앞에 둬서 '국도 31호선'이 왜 '세종대로' 검색에 나왔는지 보이게 한다.
        const names = (q ? [...all.filter((n) => n.includes(q)), ...all.filter((n) => !n.includes(q))] : all).slice(0, MAX_NAMES);
        const percent = round2(r.pct * 100);
        return {
          roadKey: r.road_key,
          displayName: r.display_name,
          highway: r.highway_major,
          names,
          /** 저장된 거리명 전체 개수(최대 200). `names`는 상위 20개만 담으므로 '외 N'은 이 값으로 센다. */
          namesTotal: all.length,
          drivenM: Math.round(r.driven),
          totalM: Math.round(r.total_length_m),
          percent,
          completed: r.pct * 100 >= COMPLETE_PERCENT,
          lastDrivenAt: r.last,
        };
      });
      return c.json({ ...base(roads), items, total }, 200);
    })
    .get('/coverage/segments', (c) => {
      const vehicleId = c.req.query('vehicleId');
      if (!vehicleId) return c.json({ error: 'vehicleId_required' as const, ...base(getRoads()) }, 400);
      const roads = getRoads();
      if (!roads) return c.json(unavailable(), 503);
      const bbox = (c.req.query('bbox') ?? '').split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
      const [minlon, minlat, maxlon, maxlat] = bbox as [number, number, number, number];
      const valid =
        bbox.length === 4 &&
        bbox.every(Number.isFinite) &&
        minlon >= -180 &&
        maxlon <= 180 &&
        minlat >= -90 &&
        maxlat <= 90 &&
        minlon < maxlon &&
        minlat < maxlat &&
        maxlon - minlon <= MAX_BBOX_SPAN_DEG &&
        maxlat - minlat <= MAX_BBOX_SPAN_DEG;
      if (!valid) return c.json({ error: 'invalid_bbox' as const, ...base(roads) }, 400);
      const rows = db
        .prepare(
          `WITH ${DRIVEN_CTE}
           SELECT w.way_id, w.road_key, ro.display_name, d.cov, d.last, w.geom_json
           FROM d JOIN ${RD}.ways w ON w.way_id = d.way_id
           JOIN ${RD}.roads ro ON ro.road_key = w.road_key
           WHERE w.way_id IN (SELECT way_id FROM ${RD}.ways_rtree WHERE minlon <= ? AND maxlon >= ? AND minlat <= ? AND maxlat >= ?)
           ORDER BY w.way_id LIMIT ?`,
        )
        .all(vehicleId, vehicleId, maxlon, minlon, maxlat, minlat, MAX_SEGMENTS + 1) as {
        way_id: number;
        road_key: string;
        display_name: string;
        cov: number;
        last: string;
        geom_json: string;
      }[];
      const truncated = rows.length > MAX_SEGMENTS;
      return c.json(
        {
          type: 'FeatureCollection' as const,
          ...base(roads),
          truncated,
          features: rows.slice(0, MAX_SEGMENTS).map((r) => ({
            type: 'Feature' as const,
            geometry: { type: 'LineString' as const, coordinates: JSON.parse(r.geom_json) as number[][] },
            properties: {
              wayId: r.way_id,
              roadKey: r.road_key,
              displayName: r.display_name,
              coverage: round2(r.cov),
              lastDrivenAt: r.last,
              /** 마지막 인정에서 365일이 지났으면 true(채도 50%로 그린다). 완료율에는 영향 없음. */
              faded: isFaded(r.last, now()),
            },
          })),
        },
        200,
      );
    });
};
