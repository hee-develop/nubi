import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Db } from '../db/index.js';

const DEV_KEY = 'nubi-dev-only-vehicle-hmac-key-do-not-use-in-production';

/** 입력은 문자열인지만 보고(길이 상한은 정규화 뒤에 본다), 정규화한 값으로 형식을 검증한다. */
const registerBody = z.object({ vin: z.string().max(256) });
const vinFormat = /^[A-Z0-9]{1,64}$/;
/** ISO 3779 표준 17자 형식(I·O·Q 제외). 이 형식이 아니어도 등록은 되지만(에뮬레이터 더미 등) 응답에 표시한다. */
const standardVin = /^[A-HJ-NPR-Z0-9]{17}$/;

const MAX_ID_LENGTH = 128;
const id = z.string().min(1).max(MAX_ID_LENGTH);
const aliasBody = z.object({ fromVehicleId: id, toVehicleId: id });

/**
 * `NUBI_VEHICLE_HMAC_KEY`가 없으면: `NODE_ENV=production`에서는 시작을 거부하고(개발용 기본 키로 만든 차량 ID는 재현 가능하다),
 * 그 밖에는 개발용 기본값을 쓰고 경고한다.
 */
export const resolveVehicleHmacKey = (
  env: string | undefined = process.env.NUBI_VEHICLE_HMAC_KEY,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string => {
  if (env && env.length > 0) return env;
  if (nodeEnv === 'production') {
    throw new Error(
      'NODE_ENV=production에서는 환경변수 NUBI_VEHICLE_HMAC_KEY(차량 ID 발급용 비밀키)가 필요합니다. 설정한 뒤 다시 시작하세요.',
    );
  }
  console.warn('경고: NUBI_VEHICLE_HMAC_KEY가 없어 개발용 기본 키를 씁니다. 공개 배포 전에 반드시 설정하세요.');
  return DEV_KEY;
};

/** vehicleId = HMAC-SHA256(서버 비밀키, VIN)의 소문자 hex. 같은 VIN은 항상 같은 ID가 되고, 비밀키 없이는 VIN으로 되돌릴 수 없다. */
export const vehicleIdOf = (key: string, vin: string) => createHmac('sha256', key).update(vin).digest('hex');

/** 공백을 지우고 대문자로 맞춘다. 같은 차량의 VIN이 표기만 달라도 같은 ID가 되게 한다. */
export const normalizeVin = (vin: string) => vin.trim().toUpperCase();

/**
 * 차량 ID 발급과 alias. VIN은 이 요청 안에서만 쓰고 저장·로그하지 않는다(응답에도 싣지 않는다).
 * 오류 응답에도 입력 값을 되돌려 주지 않는다.
 */
export const vehiclesRoutes = (key: string, db: Db) =>
  new Hono()
    .use(bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }))
    .post('/register', async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_body' }, 400);
      }
      const parsed = registerBody.safeParse(raw);
      if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
      const vin = normalizeVin(parsed.data.vin);
      if (!vinFormat.test(vin)) return c.json({ error: 'invalid_body' }, 400);
      const vehicleId = vehicleIdOf(key, vin);
      // 표준 형식이 아니면 그 사실만 알린다(VIN 자체는 어디에도 남기지 않는다).
      return standardVin.test(vin) ? c.json({ vehicleId }, 200) : c.json({ vehicleId, vinFormat: 'nonstandard' as const }, 200);
    })
    .post('/alias', async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_body' }, 400);
      }
      const parsed = aliasBody.safeParse(raw);
      if (!parsed.success || parsed.data.fromVehicleId === parsed.data.toVehicleId) return c.json({ error: 'invalid_body' }, 400);
      const { fromVehicleId, toVehicleId } = parsed.data;
      // 멱등: 같은 연결을 다시 보내면 200. 이미 다른 차량에 이어진 alias는 덮어쓰지 않는다(409).
      const r = db.prepare('INSERT OR IGNORE INTO vehicle_alias (alias_id, vehicle_id) VALUES (?, ?)').run(fromVehicleId, toVehicleId);
      if (Number(r.changes) > 0) return c.json({ ok: true as const }, 201);
      const row = db.prepare('SELECT vehicle_id FROM vehicle_alias WHERE alias_id = ?').get(fromVehicleId) as { vehicle_id: string };
      if (row.vehicle_id !== toVehicleId) return c.json({ error: 'alias_conflict' }, 409);
      return c.json({ ok: true as const }, 200);
    });
