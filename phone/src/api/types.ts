/**
 * API 타입 모음. 서버 응답 형태는 전부 Hono RPC(`AppType`)에서 추론한다(T2 합친 뒤): 서버 응답이 바뀌면 이 파일이 타입 오류로 알려 준다.
 * 손으로 쓴 것은 요청 쪽 입력 타입과 앱이 쓰는 보조 타입뿐이다.
 */
import type { InferResponseType, hc } from 'hono/client';
import type { AppType } from '@nubi/server';

type Client = ReturnType<typeof hc<AppType>>;
/** 성공(200) 응답 본문 타입. */
type Ok<E extends (...args: any[]) => any> = InferResponseType<E, 200>;

// ---- 도감·도로·트립 ----
export type CoverageSummary = Ok<Client['coverage']['summary']['$get']>;
export type RoadsPage = Ok<Client['coverage']['roads']['$get']>;
export type RoadItem = RoadsPage['items'][number];
export type RegionsSummary = Ok<Client['regions']['summary']['$get']>;
export type RegionsList = Ok<Client['regions']['list']['$get']>;
export type RegionItem = RegionsList['items'][number];
export type TripsList = Ok<Client['trips']['$get']>;
export type TripSummary = TripsList['trips'][number];

// ---- T2 (docs/specs/05b-server-ext.md) ----
/** `accountId`는 서버가 UUID 템플릿 리터럴 타입으로 주므로 string으로 넓힌다. */
export type PairClaimResult = Omit<Ok<Client['pair']['claim']['$post']>, 'accountId'> & { accountId: string };
export type GuestClaimResult = Ok<Client['guest']['claim']['$post']>;
export type GuestSessions = Ok<Client['guest']['sessions']['$get']>;
export type GuestEndResult = Ok<Client['guest'][':id']['end']['$post']>;
/** GET /me/summary. 차주는 vehicleId(+게스트로 탄 기록 합산), 게스트는 vehicleId 없음. 둘 다 activeSessionId(탑승 중인 세션, 없으면 null). 도로·시군구 DB가 없으면 regions·coverage가 null. */
export type MeSummary = Ok<Client['me']['summary']['$get']>;
export type RegionSummaryMe = NonNullable<MeSummary['regions']>;
export type CoverageMe = NonNullable<MeSummary['coverage']>;
/** POST /me/link: 읽기 전용 웹 링크(24시간). `/me?t=`(긴 수명 토큰을 URL에)는 없어졌다. */
export type MeLink = Ok<Client['me']['link']['$post']>;
export type ShareCard = Ok<Client['share']['cards']['$post']>;
/** POST /courses/:id/certificate → 공개 인증서 페이지 `/c/:id`(`url`). 같은 코스·차량은 같은 인증서. */
export type CourseCertificate = Ok<Client['courses'][':id']['certificate']['$post']>;
export type CoursesList = Ok<Client['courses']['$get']>;
export type VehicleSettings = Ok<Client['vehicles'][':id']['settings']['$get']>;
export type DeleteDataResult = Ok<Client['vehicles'][':id']['data']['$delete']>;
export type DailyReport = Ok<Client['reports']['daily']['$get']>;
export type MonthlyReport = Ok<Client['reports']['monthly']['$get']>;

export type ShareKind = 'national' | 'trip' | 'road';
export type ShareCardRequest = { vehicleId: string; kind: ShareKind; tripIds?: string[]; roadKey?: string };

/** PUT은 부분 갱신이다. 읽기 전용 필드는 보내지 않는다. */
export type SettingsPatch = Partial<Pick<VehicleSettings, 'recordingPaused' | 'homeRegion' | 'statsOptIn' | 'drivingMap' | 'hideHomeInCards'>>;
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
  /** consent는 폰에서 받은 차주 위치정보 이용 동의 값이다. 서버는 `consent: true`를 필수로 요구한다(없거나 false면 400 consent_required). */
  pairClaim(code: string, consent: true): Promise<PairClaimResult>;
  pairDelete(token: string): Promise<void>;
  guestClaim(input: { code: string; consent: true; nickname?: string }): Promise<GuestClaimResult>;
  guestEnd(sessionId: string, token: string): Promise<GuestEndResult>;
  guestDeleteData(sessionId: string, token: string): Promise<void>;
  guestSessions(vehicleId: string): Promise<GuestSessions>;
  meSummary(token: string): Promise<MeSummary>;
  /** 읽기 전용 웹 링크(24시간). `/me?t=`는 없어졌다. */
  meLink(token: string): Promise<MeLink>;
  /** 게스트 탈퇴(세션·닉네임·계정 삭제). 차주 토큰은 403 forbidden. */
  meDelete(token: string): Promise<void>;
  courses(): Promise<CoursesList>;
  /** 코스 완주 인증서 발급(멱등). 완주가 아니면 409 not_completed. `url`은 공개 페이지 `/c/:id`. */
  courseCertificate(courseId: string, vehicleId: string): Promise<CourseCertificate>;
  shareCreate(req: ShareCardRequest): Promise<ShareCard>;
  getSettings(vehicleId: string): Promise<VehicleSettings>;
  putSettings(vehicleId: string, patch: SettingsPatch): Promise<VehicleSettings>;
  deleteData(vehicleId: string): Promise<DeleteDataResult>;
}
