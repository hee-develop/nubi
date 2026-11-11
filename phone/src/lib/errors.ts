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

/** 세션이 서버에 이미 없거나 토큰이 무효인지(로컬 세션을 지워도 되는 경우). */
export const isGoneError = (e: unknown) => e instanceof ApiError && e.kind === 'http' && (e.status === 404 || e.status === 401);
