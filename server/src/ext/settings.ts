import type { Db } from '../db/index.js';

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
