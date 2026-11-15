import { ApiError } from '../api/types';
import type { TKey } from './i18n';

/** 연결·게스트 claim 오류를 T2 오류 코드(docs/specs/05b-server-ext.md)에 맞춰 문구 키로 바꾼다. */
export const claimErrorKey = (e: unknown): TKey => {
  if (e instanceof ApiError) {
    if (e.kind === 'offline') return e.code === 'timeout' ? 'connect.err.timeout' : 'connect.err.offline';
    switch (e.code) {
      case 'code_expired':
        return 'connect.err.expired';
      case 'code_not_found':
        return 'connect.err.notFound';
      case 'code_used':
        return 'connect.err.used';
      case 'already_paired':
        return 'connect.err.alreadyPaired';
      case 'too_many_requests':
      case 'rate_limited':
        return 'connect.err.rate';
      case 'invalid_body':
        return 'connect.err.invalid';
      case 'consent_required':
        return 'connect.err.consent';
      case 'own_vehicle':
        return 'connect.err.own';
      case 'guest_limit':
        return 'connect.err.guestLimit';
      case 'already_in_session':
        return 'connect.err.inSession';
    }
  }
  return 'connect.err.unknown';
};

const isHttp = (e: unknown, status: number, code?: string): e is ApiError => e instanceof ApiError && e.kind === 'http' && e.status === status && (code === undefined || e.code === code);
const isOffline = (e: unknown) => e instanceof ApiError && e.kind === 'offline';

/** 공유 카드 만들기 오류(T2): 503 png_unavailable, 409 trip_not_eligible·too_short·not_completed, 429, 401(토큰 만료·폐기). */
export const shareErrorKey = (e: unknown): TKey => {
  if (isOffline(e)) return 'share.err.offline';
  if (isHttp(e, 503, 'png_unavailable')) return 'share.err.png';
  if (isHttp(e, 409, 'trip_not_eligible')) return 'share.err.notEligible';
  if (isHttp(e, 409, 'too_short')) return 'share.err.tooShort';
  if (isHttp(e, 409, 'not_completed')) return 'share.err.notCompleted';
  if (isHttp(e, 429)) return 'share.err.rate';
  if (isHttp(e, 401)) return 'share.err.auth';
  return 'share.err.create';
};

/** 설정 저장 오류(T2): 403 local_only(인증 off 서버에 원격 접속), 400 invalid_region·invalid_body, 401. */
export const settingsErrorKey = (e: unknown): TKey => {
  if (isOffline(e)) return 'settings.err.offline';
  if (isHttp(e, 403, 'local_only')) return 'settings.err.localOnly';
  if (isHttp(e, 400, 'invalid_region')) return 'settings.err.region';
  if (isHttp(e, 401)) return 'settings.err.auth';
  return 'settings.err.save';
};

/** 세션이 서버에 이미 없거나 토큰이 무효인지(로컬 세션을 지워도 되는 경우). */
export const isGoneError = (e: unknown) => e instanceof ApiError && e.kind === 'http' && (e.status === 404 || e.status === 401);
