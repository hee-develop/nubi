import type { Db } from '../db/index.js';
import { canonicalVehicleId } from '../matching/pipeline.js';

type SettingsRow = {
  recording_paused: number;
  home_region: string | null;
  stats_opt_in: number;
  drive_map: number;
  hide_home_in_cards: number;
  consent_withdrawn_at: string | null;
};

/** 차량 설정(없으면 기본값). */
export const readSettings = (db: Db, vehicleId: string) => {
  const r = db.prepare('SELECT * FROM vehicle_settings WHERE vehicle_id = ?').get(vehicleId) as SettingsRow | undefined;
  return {
    recordingPaused: (r?.recording_paused ?? 0) === 1,
    homeRegion: r?.home_region ?? null,
    statsOptIn: (r?.stats_opt_in ?? 1) === 1,
    drivingMap: (r?.drive_map ?? 1) === 1,
    hideHomeInCards: (r?.hide_home_in_cards ?? 1) === 1,
    consentWithdrawnAt: r?.consent_withdrawn_at ?? null,
  };
};

/** 그 차량의 기록을 받으면 안 되는 상태인가: 기록 멈춤 또는 위치정보 동의 철회. T1 `/trips/:id/live`도 이 함수로 막는다. */
export const isRecordingBlocked = (db: Db, vehicleId: string): boolean => {
  const s = readSettings(db, canonicalVehicleId(db, vehicleId));
  return s.recordingPaused || s.consentWithdrawnAt !== null;
};

/**
 * 진행 중 매칭·실시간 매칭·지역 판정이 결과를 **쓰기 직전에** 부른다(삭제와의 경합 방지, 같은 틱 안에서 확인하고 바로 써야 한다).
 * deleted: 트립이 지워졌다(데이터 삭제). withdrawn: 그 차량이 동의를 철회했다. ok: 써도 된다.
 */
export const tripDataState = (db: Db, tripId: string): 'ok' | 'deleted' | 'withdrawn' => {
  const t = db.prepare('SELECT vehicle_id FROM trips WHERE id = ?').get(tripId) as { vehicle_id: string } | undefined;
  if (!t) return 'deleted';
  return readSettings(db, canonicalVehicleId(db, t.vehicle_id)).consentWithdrawnAt !== null ? 'withdrawn' : 'ok';
};
