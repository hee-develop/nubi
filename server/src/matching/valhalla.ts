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

/**
 * retryable=true: 네트워크·5xx·408·425·429(5분 뒤 재시도). false: 4xx(영구 실패).
 * [code]는 API·DB에 남기는 분류 코드(`network`·`http_503`·`bad_response`)이고, [message]는 서버 로그에만 쓴다.
 */
export class ValhallaError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string = retryable ? 'retryable' : 'permanent',
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

/**
 * 트립을 Valhalla 요청 조각으로 나눈다.
 * - 한 걸음이 [breakageM](`breakage_distance`, 2,000m)을 넘는 점프에서는 조각을 끊는다. 점프 구간은 이어 붙일 수 없으므로 겹치는 점 없이 새 조각이 점프 도착점에서 시작한다.
 * - 점 [maxPoints]개 또는 누적 거리 [maxDistanceM](150km)을 넘기 전에 끊는다. 이때는 경계 구간이 끊기지 않게 점 하나를 겹친다.
 * - 첫 점·분할 직후에도 한도를 넘는 걸음은 받지 않는다(그 걸음은 점프로 취급). 점이 하나뿐인 조각은 보내지 않는다.
 */
export const splitTrace = <T extends TracePoint>(
  points: T[],
  maxPoints = MAX_POINTS_PER_REQUEST,
  maxDistanceM = MAX_DISTANCE_PER_REQUEST_M,
  breakageM = TRACE_OPTIONS.breakage_distance,
): T[][] => {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let dist = 0;
  const flush = () => {
    if (cur.length > 1) chunks.push(cur);
  };
  for (const p of points) {
    const last = cur.at(-1);
    if (last) {
      const step = haversineM(last.lat, last.lon, p.lat, p.lon);
      if (step > breakageM || step > maxDistanceM) {
        flush();
        cur = [];
        dist = 0;
      } else if (cur.length >= maxPoints || dist + step > maxDistanceM) {
        flush();
        cur = [last];
        dist = step;
      } else {
        dist += step;
      }
    }
    cur.push(p);
  }
  flush();
  return chunks;
};

export type TraceDeps = { fetchFn?: typeof fetch; baseUrl?: string; timeoutMs?: number };

export const traceAttributes = async (points: TracePoint[], deps: TraceDeps = {}): Promise<TraceResult> => {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = (deps.baseUrl ?? process.env.NUBI_VALHALLA_URL ?? 'http://127.0.0.1:8002').replace(/\/$/, '');
  const out: TraceResult = { wayLengthsM: new Map(), matchedPoints: 0, unmatchedPoints: 0, edgeCount: 0, requests: 0 };
  const chunks = splitTrace(points);
  // 점프로 외따로 떨어져 요청에 들어가지 못한 점은 unmatched로 센다(low_confidence 판정에 반영).
  out.unmatchedPoints += points.length - new Set(chunks.flat()).size;
  for (const chunk of chunks) {
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
      throw new ValhallaError(`network: ${e instanceof Error ? e.name : 'error'}`, true, 'network');
    }
    out.requests++;
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429;
      throw new ValhallaError(`valhalla HTTP ${res.status}`, retryable, `http_${res.status}`);
    }
    let json: TraceResponse;
    try {
      json = (await res.json()) as TraceResponse;
    } catch {
      throw new ValhallaError('valhalla 응답 형식 오류', true, 'bad_response');
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
