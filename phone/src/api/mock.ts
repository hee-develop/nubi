import { buildRegions, buildRoads, buildTrips } from './mock-data';
import { ApiError, type NubiApi, type VehicleSettings } from './types';

export const MOCK_VEHICLE_ID = 'mock-vehicle-0001';
/** 목 연결 코드: 000000 = 만료, 111111 = 사용 중 아님(알 수 없는 코드), 그 밖의 6자리 = 성공. */
export const MOCK_CODE_EXPIRED = '000000';
export const MOCK_CODE_UNKNOWN = '111111';
const ATTRIBUTION = '© OpenStreetMap contributors';
const SNAPSHOT = '2026-11';

export type MockOptions = { latencyMs?: number; baseUrl?: string; mode?: 'mock' | 'hybrid' };

const COMPLETE_PERCENT = 95;

/** 서버 없이 도는 목 구현. 상태(설정·게스트·삭제)는 인스턴스 안에 둔다. */
export const createMockApi = (opts: MockOptions = {}): NubiApi => {
  const latency = opts.latencyMs ?? 120;
  const wait = () => (latency > 0 ? new Promise<void>((r) => setTimeout(r, latency)) : Promise.resolve());
  const baseUrl = opts.baseUrl ?? '';
  let regions = buildRegions();
  let roads = buildRoads();
  let trips = buildTrips(MOCK_VEHICLE_ID);
  let settings: VehicleSettings = { recordingPaused: false, homeRegion: null, statsOptIn: true, drivingMap: true };
  const guests = new Map<string, boolean>();
  let deleted = false;

  const base = { snapshotMonth: SNAPSHOT, attribution: ATTRIBUTION };
  const api = <T>(f: () => T) => async (): Promise<T> => {
    await wait();
    return f();
  };
  const withWait = async <T>(f: () => T): Promise<T> => {
    await wait();
    return f();
  };

  return {
    mode: opts.mode ?? 'mock',
    baseUrl,
    viewerUrl: (vehicleId) => `${baseUrl}/viewer?vehicleId=${encodeURIComponent(vehicleId)}`,

    coverageSummary: () =>
      withWait(() => {
        const driven = roads.reduce((a, r) => a + r.drivenM, 0);
        return {
          ...base,
          nationalPercent: deleted ? 0 : 0.0012,
          drivenKm: deleted ? 0 : Math.round(driven / 10) / 100,
          totalKm: 1_000_000,
          roadsCompleted: deleted ? 0 : roads.filter((r) => r.percent >= COMPLETE_PERCENT).length,
          roadsStarted: deleted ? 0 : roads.length,
        };
      }),
    coverageRoads: (_v, q = {}) =>
      withWait(() => {
        let items = deleted ? [] : [...roads];
        if (q.filter === 'almost') items = items.filter((r) => r.percent >= 80 && r.percent < 95);
        if (q.q) items = items.filter((r) => r.displayName.includes(q.q!));
        const sort = q.sort ?? 'percent';
        items.sort((a, b) => (sort === 'length' ? b.drivenM - a.drivenM : sort === 'recent' ? b.lastDrivenAt.localeCompare(a.lastDrivenAt) : b.percent - a.percent));
        const offset = q.offset ?? 0;
        const limit = q.limit ?? 50;
        return { ...base, total: items.length, limit, offset, items: items.slice(offset, offset + limit) } as never;
      }),
    regionsSummary: () =>
      withWait(() => {
        const rs = deleted ? regions.map((r) => ({ ...r, level: 0 })) : regions;
        const colored = rs.filter((r) => r.level >= 1);
        const last = rs.filter((r) => r.lastAt).sort((a, b) => b.lastAt!.localeCompare(a.lastAt!))[0];
        return {
          ...base,
          total: rs.length,
          colored: colored.length,
          byLevel: { '1': rs.filter((r) => r.level === 1).length, '2': rs.filter((r) => r.level === 2).length, '3': rs.filter((r) => r.level === 3).length },
          depop: {
            total: rs.filter((r) => r.depop92).length,
            colored: colored.filter((r) => r.depop92).length,
            total89: rs.filter((r) => r.depop89).length,
            colored89: colored.filter((r) => r.depop89).length,
          },
          lastEvent: last ? { kind: 'visit' as const, code: last.code, name: last.displayName, sidoName: last.sidoName, at: last.lastAt!, tripId: 'mock-trip-1' } : null,
        };
      }),
    regionsList: (_v, q = {}) =>
      withWait(() => {
        let items = deleted ? regions.map((r) => ({ ...r, level: 0, faded: false, lastAt: null, firstAt: null })) : regions;
        if (q.filter === 'depop') items = items.filter((r) => r.depop92 || r.depop89);
        if (q.filter === 'uncolored') items = items.filter((r) => r.level === 0);
        return { ...base, items } as never;
      }),
    trips: (vehicleId, limit = 10) => withWait(() => ({ trips: deleted ? [] : trips.slice(0, limit).map((t) => ({ ...t, vehicleId })) })),

    reportsDaily: (_v, date) =>
      withWait(() => ({ date, newKm: deleted ? 0 : 18.4, newRegions: deleted ? [] : [{ code: '11110', displayName: '서울 종로구' }], tripCount: deleted ? 0 : 2, distanceKm: deleted ? 0 : 41.2 })),
    reportsMonthly: (_v, month) =>
      withWait(() => ({
        month,
        newKm: deleted ? 0 : 212.6,
        newRegions: deleted ? [] : [{ code: '11110', displayName: '서울 종로구' }, { code: '51720', displayName: '강원 홍천군' }],
        tripCount: deleted ? 0 : 19,
        distanceKm: deleted ? 0 : 610.3,
      })),

    pairClaim: (code) =>
      withWait(() => {
        if (!/^\d{6}$/.test(code)) throw new ApiError('http', 400, 'invalid_code');
        if (code === MOCK_CODE_EXPIRED) throw new ApiError('http', 410, 'code_expired');
        if (code === MOCK_CODE_UNKNOWN) throw new ApiError('http', 404, 'code_not_found');
        return { accountId: 'mock-account-1', token: `mock-token-${code}`, vehicleId: MOCK_VEHICLE_ID };
      }),
    pairDelete: api(() => undefined),
    guestClaim: (input) =>
      withWait(() => {
        if (input.consent !== true) throw new ApiError('http', 400, 'consent_required');
        if (!/^\d{6}$/.test(input.code)) throw new ApiError('http', 400, 'invalid_code');
        if (input.code === MOCK_CODE_EXPIRED) throw new ApiError('http', 410, 'code_expired');
        if (input.code === MOCK_CODE_UNKNOWN) throw new ApiError('http', 404, 'code_not_found');
        const sessionId = `mock-guest-${guests.size + 1}`;
        guests.set(sessionId, true);
        return { sessionId, token: `mock-guest-token-${sessionId}` };
      }),
    guestEnd: (sessionId) =>
      withWait(() => {
        guests.delete(sessionId);
      }),
    guestSessions: () => withWait(() => ({ active: guests.size })),
    meSummary: () => withWait(() => ({ regionsColored: 3, regionsTotal: 229, newKm: 14.2, tripCount: 1 })),

    shareCreate: (req) =>
      withWait(() => {
        if (req.kind === 'trip' && !req.tripIds?.length) throw new ApiError('http', 400, 'trip_required');
        if (req.kind === 'road' && !req.roadKey) throw new ApiError('http', 400, 'road_required');
        const id = `mock-card-${req.kind}`;
        return { id, url: `${baseUrl || 'https://nubi.example'}/s/${id}`, imageUrl: 'mock:share-card' };
      }),

    getSettings: () => withWait(() => ({ ...settings })),
    putSettings: (_v, s) =>
      withWait(() => {
        settings = { ...s };
        return { ...settings };
      }),
    deleteData: () =>
      withWait(() => {
        deleted = true;
        settings = { recordingPaused: false, homeRegion: null, statsOptIn: true, drivingMap: true };
        trips = [];
        roads = [];
        regions = regions.map((r) => ({ ...r, level: 0, faded: false }));
      }),
  };
};
