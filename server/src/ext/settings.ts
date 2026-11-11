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

/** 멈춤 구간 하나(ms). [to]가 null이면 열려 있다(지금도 멈춤). */
export type PauseSpan = { from: number; to: number | null };

/** 그 차량(정본 ID)의 멈춤 구간 전부. */
export const pauseSpans = (db: Db, vehicleId: string): PauseSpan[] =>
  (db.prepare('SELECT paused_at, resumed_at FROM recording_pauses WHERE vehicle_id = ? ORDER BY paused_at').all(vehicleId) as { paused_at: string; resumed_at: string | null }[]).map((r) => ({
    from: Date.parse(r.paused_at),
    to: r.resumed_at === null ? null : Date.parse(r.resumed_at),
  }));

/** [tsMs]가 멈춤 구간 안이면 그 구간의 시작(ms), 아니면 null. 시작은 포함, 끝(재개)은 제외. */
export const pausedSpanAt = (spans: PauseSpan[], tsMs: number): PauseSpan | null =>
  Number.isFinite(tsMs) ? (spans.find((s) => tsMs >= s.from && (s.to === null || tsMs < s.to)) ?? null) : null;

/** 마지막으로 멈춤 상태가 바뀐 시각(ms, 없으면 0). 오래된 켜기·끄기 의도를 가리는 데 쓴다. */
export const lastPauseChange = (spans: PauseSpan[]): number => spans.reduce((m, s) => Math.max(m, s.from, s.to ?? 0), 0);

/** 멈춤 상태가 바뀌었다: 켜면 열린 구간이 없을 때 구간을 열고, 끄면 열린 구간을 닫는다. */
export const syncPauseSpan = (db: Db, vehicleId: string, paused: boolean, atMs: number): void => {
  const open = db.prepare('SELECT rowid FROM recording_pauses WHERE vehicle_id = ? AND resumed_at IS NULL').get(vehicleId);
  const at = new Date(atMs).toISOString();
  if (paused && !open) db.prepare('INSERT INTO recording_pauses (vehicle_id, paused_at, resumed_at) VALUES (?, ?, NULL)').run(vehicleId, at);
  if (!paused && open) db.prepare('UPDATE recording_pauses SET resumed_at = ? WHERE vehicle_id = ? AND resumed_at IS NULL').run(at, vehicleId);
};
