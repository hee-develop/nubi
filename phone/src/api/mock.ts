import { buildRegions, buildRoads, buildTrips } from './mock-data';
import { ApiError, type NubiApi, type VehicleSettings } from './types';

export const MOCK_VEHICLE_ID = 'mock-vehicle-0001';
/**
 * 목 코드(T2와 같은 오류 코드): 000000 만료(410 code_expired), 111111 없음(404 code_not_found), 222222 이미 씀(410 code_used),
 * 333333 이미 연결됨(409 already_paired, 차주 연결만), 444444 시도 제한(429 too_many_requests),
 * 555555 게스트 가득(409 guest_limit), 666666 이미 세션 중(409 already_in_session), 777777 내 차(409 own_vehicle). 그 밖의 6자리는 성공.
 */
export const MOCK_CODE_EXPIRED = '000000';
export const MOCK_CODE_UNKNOWN = '111111';
export const MOCK_CODE_USED = '222222';
export const MOCK_CODE_ALREADY_PAIRED = '333333';
export const MOCK_CODE_RATE = '444444';
export const MOCK_CODE_GUEST_LIMIT = '555555';
export const MOCK_CODE_IN_SESSION = '666666';
export const MOCK_CODE_OWN_VEHICLE = '777777';

const checkCommon = (code: string) => {
  if (!/^\d{6}$/.test(code)) throw new ApiError('http', 400, 'invalid_body');
  if (code === MOCK_CODE_RATE) throw new ApiError('http', 429, 'too_many_requests');
  if (code === MOCK_CODE_UNKNOWN) throw new ApiError('http', 404, 'code_not_found');
  if (code === MOCK_CODE_USED) throw new ApiError('http', 410, 'code_used');
  if (code === MOCK_CODE_EXPIRED) throw new ApiError('http', 410, 'code_expired');
};
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
  const defaultSettings = (): VehicleSettings => ({ recordingPaused: false, homeRegion: null, statsOptIn: true, drivingMap: true, hideHomeInCards: true, consentWithdrawnAt: null });
  let settings = defaultSettings();
  /** sessionId → 상태. 내리면 ended, 기록 삭제하면 deleted. */
  const guests = new Map<string, { ended: boolean; deleted: boolean }>();
  const activeGuests = () => [...guests.values()].filter((g) => !g.ended).length;
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
          revivedKm: deleted ? 0 : 3.2,
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
      withWait(() => ({
        date,
        tripCount: deleted ? 0 : 2,
        distanceKm: deleted ? 0 : 41.2,
        newKm: deleted ? 0 : 18.4,
        newWays: deleted ? 0 : 36,
        revivedKm: 0,
        newRegions: deleted ? [] : [{ code: '11110', displayName: '서울 종로구', sidoName: '서울' }],
        newStays: [],
      })),
    reportsMonthly: (_v, month) =>
      withWait(() => ({
        month,
        tripCount: deleted ? 0 : 19,
        distanceKm: deleted ? 0 : 610.3,
        newKm: deleted ? 0 : 212.6,
        newWays: deleted ? 0 : 410,
        revivedKm: deleted ? 0 : 3.2,
        newRegions: deleted ? [] : [{ code: '11110', displayName: '서울 종로구', sidoName: '서울' }, { code: '51720', displayName: '강원 홍천군', sidoName: '강원' }],
        newStays: [],
        daysDriven: deleted ? 0 : 9,
      })),

    pairClaim: (code, consent) =>
      withWait(() => {
        // 서버는 consent: true를 필수로 요구한다(없거나 false면 400 consent_required).
        if ((consent as boolean) !== true) throw new ApiError('http', 400, 'consent_required');
        checkCommon(code);
        if (code === MOCK_CODE_ALREADY_PAIRED) throw new ApiError('http', 409, 'already_paired');
        return { accountId: 'mock-account-1', token: `mock-token-${code}`, vehicleId: MOCK_VEHICLE_ID };
      }),
    pairDelete: api(() => undefined),
    guestClaim: (input) =>
      withWait(() => {
        if (input.consent !== true) throw new ApiError('http', 400, 'consent_required');
        checkCommon(input.code);
        if (input.code === MOCK_CODE_GUEST_LIMIT) throw new ApiError('http', 409, 'guest_limit');
        if (input.code === MOCK_CODE_IN_SESSION) throw new ApiError('http', 409, 'already_in_session');
        if (input.code === MOCK_CODE_OWN_VEHICLE) throw new ApiError('http', 409, 'own_vehicle');
        const sessionId = `mock-guest-${guests.size + 1}`;
        guests.set(sessionId, { ended: false, deleted: false });
        return { sessionId, token: `mock-guest-token-${sessionId}` };
      }),
    guestEnd: (sessionId) =>
      withWait(() => {
        const g = guests.get(sessionId);
        if (!g) throw new ApiError('http', 404, 'not_found');
        const already = g.ended;
        g.ended = true;
        return { ok: true as const, endedAt: '2026-11-11T09:00:00.000Z', alreadyEnded: already };
      }),
    guestDeleteData: (sessionId) =>
      withWait(() => {
        const g = guests.get(sessionId);
        if (!g) throw new ApiError('http', 404, 'not_found');
        g.deleted = true;
      }),
    guestSessions: () => withWait(() => ({ active: activeGuests() })),
    meSummary: (token) =>
      withWait(() => {
        const id = token.replace('mock-guest-token-', '');
        const g = guests.get(id);
        const deleted = !!g?.deleted;
        return {
          role: 'guest' as const,
          activeSessionId: g && !g.ended ? id : null,
          attribution: ATTRIBUTION,
          regionsAttribution: ATTRIBUTION,
          regions: { total: 229, colored: deleted ? 0 : 3, byLevel: { '1': deleted ? 0 : 2, '2': 0, '3': deleted ? 0 : 1 }, depop: { total: 92, colored: deleted ? 0 : 1 } },
          coverage: { nationalPercent: deleted ? 0 : 0.0004, drivenKm: deleted ? 0 : 14.2, totalKm: 1_000_000, roadsStarted: deleted ? 0 : 4, roadsCompleted: 0 },
          snapshotMonth: SNAPSHOT,
        };
      }),

    meLink: (token) =>
      withWait(() => {
        if (!token) throw new ApiError('http', 401, 'unauthorized');
        return { url: `${baseUrl || 'https://nubi.example'}/me?v=mock-view-token`, expiresAt: '2026-11-12T09:00:00.000Z' };
      }),
    meDelete: (token) =>
      withWait(() => {
        if (token.startsWith('mock-token-')) throw new ApiError('http', 403, 'forbidden'); // 차주는 DELETE /pair
        const g = guests.get(token.replace('mock-guest-token-', ''));
        if (!g) throw new ApiError('http', 401, 'unauthorized');
        g.ended = true;
        g.deleted = true;
      }),
    courses: () => withWait(() => ({ items: [{ id: 'mock-course-1', name: '동해안 7번 국도', regionCode: '42150', lengthKm: 82.4 }] })),
    courseCertificate: (courseId) =>
      withWait(() => {
        if (courseId !== 'mock-course-1') throw new ApiError('http', 404, 'not_found');
        if (roads.every((r) => r.percent < COMPLETE_PERCENT)) throw new ApiError('http', 409, 'not_completed');
        return { id: 'mock-certificate-1', number: 'NB-MOCK-0001', url: `${baseUrl || 'https://nubi.example'}/c/mock-certificate-1` };
      }),

    shareCreate: (req) =>
      withWait(() => {
        if (req.kind === 'trip' && !req.tripIds?.length) throw new ApiError('http', 400, 'trip_required');
        if (req.kind === 'road' && !req.roadKey) throw new ApiError('http', 400, 'road_required');
        const id = `mock-card-${req.kind}`;
        return { id, url: `${baseUrl || 'https://nubi.example'}/s/${id}`, imageUrl: 'mock:share-card.png' };
      }),

    getSettings: () => withWait(() => ({ ...settings })),
    putSettings: (_v, patch) =>
      withWait(() => {
        if (patch.homeRegion && !regions.some((r) => r.code === patch.homeRegion)) throw new ApiError('http', 400, 'invalid_region');
        settings = { ...settings, ...patch };
        return { ...settings };
      }),
    deleteData: () =>
      withWait(() => {
        deleted = true;
        settings = { ...defaultSettings(), recordingPaused: true, consentWithdrawnAt: '2026-11-11T09:00:00.000Z' };
        trips = [];
        roads = [];
        regions = regions.map((r) => ({ ...r, level: 0, faded: false }));
        return { ok: true as const, deleted: { trips: 5, points: 2150, ways: 1200, regions: 5 } };
      }),
  };
};
