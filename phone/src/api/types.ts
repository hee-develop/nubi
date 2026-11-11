/**
 * API 타입 모음.
 *  - 서버에 이미 있는 API: Hono RPC(`AppType`)에서 추론한다.
 *  - 아직 없는 새 API(계약서 docs/specs/05-night-plan.md 3장): 손으로 정의한다. T2를 합친 뒤에는 이 파일의 '계약 타입'을
 *    RPC 추론 타입으로 바꾸면 된다(한 곳에 모아 둔 이유).
 */
import type { InferResponseType, hc } from 'hono/client';
import type { AppType } from '@nubi/server';

type Client = ReturnType<typeof hc<AppType>>;

// ---- 서버에 있는 API (RPC 추론) ----
export type CoverageSummary = InferResponseType<Client['coverage']['summary']['$get'], 200>;
export type RoadsPage = InferResponseType<Client['coverage']['roads']['$get'], 200>;
export type RoadItem = RoadsPage['items'][number];
export type RegionsSummary = InferResponseType<Client['regions']['summary']['$get'], 200>;
type RegionsListRaw = InferResponseType<Client['regions']['list']['$get'], 200>;
/** `faded`는 T2가 /regions/list 항목에 추가한다(계약서 3장). 아직 없으면 undefined = 바램 아님. */
export type RegionItem = RegionsListRaw['items'][number] & { faded?: boolean };
export type RegionsList = Omit<RegionsListRaw, 'items'> & { items: RegionItem[] };
export type TripsList = InferResponseType<Client['trips']['$get'], 200>;
export type TripSummary = TripsList['trips'][number];

// ---- T2 실제 응답 형태 (docs/specs/05b-server-ext.md, server/src/routes/*). T2를 합친 뒤에는 RPC 추론으로 바꾼다. ----
export type PairClaimResult = { accountId: string; token: string; vehicleId: string };
export type GuestClaimResult = { sessionId: string; token: string };
export type GuestSessions = { active: number };
export type GuestEndResult = { ok: true; endedAt: string; alreadyEnded: boolean };

export type RegionSummaryMe = { total: number; colored: number; byLevel: Record<'1' | '2' | '3', number>; depop: { total: number; colored: number } };
export type CoverageMe = { nationalPercent: number; drivenKm: number; totalKm: number; roadsStarted: number; roadsCompleted: number };
/** GET /me/summary. 차주는 vehicleId, 게스트는 activeSessionId(세션이 끝났으면 null). 도로·시군구 DB가 없으면 regions·coverage가 null. */
export type MeSummary = {
  role: 'owner' | 'guest';
  vehicleId?: string;
  activeSessionId?: string | null;
  regions: RegionSummaryMe | null;
  coverage: CoverageMe | null;
  snapshotMonth: string | null;
};

export type ShareKind = 'national' | 'trip' | 'road';
export type ShareCardRequest = { vehicleId: string; kind: ShareKind; tripIds?: string[]; roadKey?: string };
export type ShareCard = { id: string; url: string; imageUrl: string };

export type VehicleSettings = {
  recordingPaused: boolean;
  /** 내 지역 시군구 코드(5자리). 지정 안 함이면 null. */
  homeRegion: string | null;
  statsOptIn: boolean;
  drivingMap: boolean;
  hideHomeInCards: boolean;
  consentWithdrawnAt: string | null;
};
/** PUT은 부분 갱신이다. 읽기 전용 필드는 보내지 않는다. */
export type SettingsPatch = Partial<Pick<VehicleSettings, 'recordingPaused' | 'homeRegion' | 'statsOptIn' | 'drivingMap' | 'hideHomeInCards'>>;
export type DeleteDataResult = { ok: true; deleted: { trips: number; points: number; ways: number; regions: number } };

type ReportRegion = { code: string; displayName: string; sidoName: string };
type ReportBase = {
  tripCount: number;
  distanceKm: number;
  newKm: number;
  newWays: number;
  revivedKm: number;
  newRegions: ReportRegion[];
  newStays: ReportRegion[];
};
export type DailyReport = ReportBase & { date: string };
export type MonthlyReport = ReportBase & { month: string; daysDriven: number };

/** 앱이 쓰는 오류 분류. offline = 네트워크에 못 닿음, http = 서버가 오류 코드를 줌. */
export class ApiError extends Error {
  constructor(
    public kind: 'offline' | 'http',
    public status: number,
    public code: string,
  ) {
    super(`${kind}:${status}:${code}`);
    this.name = 'ApiError';
  }
}

export type RoadsQuery = { filter?: 'almost'; sort?: 'percent' | 'recent' | 'length'; limit?: number; offset?: number; q?: string };
export type RegionsQuery = { filter?: 'all' | 'depop' | 'uncolored'; sort?: 'recent' | 'name' };

/** 화면이 쓰는 API 표면. live·mock이 같은 모양을 구현한다. */
export interface NubiApi {
  mode: 'mock' | 'hybrid' | 'live';
  baseUrl: string;
  viewerUrl(vehicleId: string): string;
  // 기존
  coverageSummary(vehicleId: string): Promise<CoverageSummary>;
  coverageRoads(vehicleId: string, q?: RoadsQuery): Promise<RoadsPage>;
  regionsSummary(vehicleId: string): Promise<RegionsSummary>;
  regionsList(vehicleId: string, q?: RegionsQuery): Promise<RegionsList>;
  trips(vehicleId: string, limit?: number): Promise<TripsList>;
  // 새 API
  reportsDaily(vehicleId: string, date: string): Promise<DailyReport>;
  reportsMonthly(vehicleId: string, month: string): Promise<MonthlyReport>;
  /** consent는 폰에서 받은 차주 위치정보 이용 동의 값이다(true만 보낸다). */
  pairClaim(code: string, consent: boolean): Promise<PairClaimResult>;
  pairDelete(token: string): Promise<void>;
  guestClaim(input: { code: string; consent: true; nickname?: string }): Promise<GuestClaimResult>;
  guestEnd(sessionId: string, token: string): Promise<GuestEndResult>;
  guestDeleteData(sessionId: string, token: string): Promise<void>;
  guestSessions(vehicleId: string): Promise<GuestSessions>;
  meSummary(token: string): Promise<MeSummary>;
  shareCreate(req: ShareCardRequest): Promise<ShareCard>;
  getSettings(vehicleId: string): Promise<VehicleSettings>;
  putSettings(vehicleId: string, patch: SettingsPatch): Promise<VehicleSettings>;
  deleteData(vehicleId: string): Promise<DeleteDataResult>;
}
