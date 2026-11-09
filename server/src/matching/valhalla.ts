/** Valhalla `trace_attributes` 호출(사양 02 3-1). Node 내장 `fetch`를 쓰고, 테스트는 [fetchFn]을 바꿔 끼운다. */
import { haversineM } from '../routes/trips.js';

export type TracePoint = { lat: number; lon: number };

/** 요청당 점 상한(Valhalla `max_shape`). */
export const MAX_POINTS_PER_REQUEST = 16_000;
/** 요청당 누적 거리 상한(m). Valhalla 기본 `max_distance` 200km 아래로 나눠 보낸다. */
export const MAX_DISTANCE_PER_REQUEST_M = 150_000;

export const ATTRIBUTES = [
  'edge.way_id',
  'edge.length',
  'edge.names',
  'edge.road_class',
  'edge.begin_shape_index',
  'edge.end_shape_index',
  'matched.point',
  'matched.type',
  'matched.edge_index',
];

export const TRACE_OPTIONS = { search_radius: 50, gps_accuracy: 10, breakage_distance: 2000 };

/** retryable=true: 네트워크·5xx·408·425·429(5분 뒤 재시도). false: 4xx(영구 실패). */
export class ValhallaError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type TraceResult = {
  /** way_id → 매칭 길이(m) 합. */
  wayLengthsM: Map<number, number>;
  matchedPoints: number;
  unmatchedPoints: number;
  edgeCount: number;
  requests: number;
};

type TraceResponse = {
  edges?: { way_id?: number; length?: number }[];
  matched_points?: { type?: string }[];
};

/** 점 16,000개 또는 누적 거리 150km를 넘기 전에 나눈다. 조각 경계의 점 하나는 겹치게 두어 경계 구간이 끊기지 않게 한다. */
export const splitTrace = <T extends TracePoint>(
  points: T[],
  maxPoints = MAX_POINTS_PER_REQUEST,
  maxDistanceM = MAX_DISTANCE_PER_REQUEST_M,
): T[][] => {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let dist = 0;
  for (const p of points) {
    const last = cur.at(-1);
    if (last) {
      const step = haversineM(last.lat, last.lon, p.lat, p.lon);
      if (cur.length >= maxPoints || (cur.length > 1 && dist + step > maxDistanceM)) {
        chunks.push(cur);
        cur = [last];
        dist = 0;
      }
      dist += step;
    }
    cur.push(p);
  }
  if (cur.length > 1 || chunks.length === 0) chunks.push(cur);
  return chunks;
};

export type TraceDeps = { fetchFn?: typeof fetch; baseUrl?: string; timeoutMs?: number };

export const traceAttributes = async (points: TracePoint[], deps: TraceDeps = {}): Promise<TraceResult> => {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = (deps.baseUrl ?? process.env.NUBI_VALHALLA_URL ?? 'http://127.0.0.1:8002').replace(/\/$/, '');
  const out: TraceResult = { wayLengthsM: new Map(), matchedPoints: 0, unmatchedPoints: 0, edgeCount: 0, requests: 0 };
  for (const chunk of splitTrace(points)) {
    const body = {
      shape: chunk.map((p) => ({ lat: p.lat, lon: p.lon })),
      costing: 'auto',
      shape_match: 'map_snap',
      trace_options: TRACE_OPTIONS,
      filters: { attributes: ATTRIBUTES, action: 'include' },
    };
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}/trace_attributes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new ValhallaError(`network: ${e instanceof Error ? e.name : 'error'}`, true);
    }
    out.requests++;
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429;
      throw new ValhallaError(`valhalla HTTP ${res.status}`, retryable);
    }
    let json: TraceResponse;
    try {
      json = (await res.json()) as TraceResponse;
    } catch {
      throw new ValhallaError('valhalla 응답 형식 오류', true);
    }
    for (const e of json.edges ?? []) {
      out.edgeCount++;
      if (typeof e.way_id !== 'number' || typeof e.length !== 'number') continue;
      // units 기본값이 km다(실측 2026-11-09).
      out.wayLengthsM.set(e.way_id, (out.wayLengthsM.get(e.way_id) ?? 0) + e.length * 1000);
    }
    for (const m of json.matched_points ?? []) {
      if (m.type === 'unmatched') out.unmatchedPoints++;
      else out.matchedPoints++;
    }
  }
  return out;
};
