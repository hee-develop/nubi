import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

const DEV_KEY = 'nubi-dev-only-vehicle-hmac-key-do-not-use-in-production';

const registerBody = z.object({ vin: z.string().min(1).max(64) });

/** `NUBI_VEHICLE_HMAC_KEY`가 없으면 개발용 기본값을 쓰고 경고한다(기본값으로 만든 차량 ID는 운영에서 재현 가능하므로 공개 배포 금지). */
export const resolveVehicleHmacKey = (env: string | undefined = process.env.NUBI_VEHICLE_HMAC_KEY): string => {
  if (env && env.length > 0) return env;
  console.warn('경고: NUBI_VEHICLE_HMAC_KEY가 없어 개발용 기본 키를 씁니다. 공개 배포 전에 반드시 설정하세요.');
  return DEV_KEY;
};

/** vehicleId = HMAC-SHA256(서버 비밀키, VIN)의 소문자 hex. 같은 VIN은 항상 같은 ID가 되고, 비밀키 없이는 VIN으로 되돌릴 수 없다. */
export const vehicleIdOf = (key: string, vin: string) => createHmac('sha256', key).update(vin).digest('hex');

/**
 * 차량 ID 발급. VIN은 이 요청 안에서만 쓰고 저장·로그하지 않는다(응답에도 싣지 않는다).
 * 오류 응답에도 입력 값을 되돌려 주지 않는다.
 */
export const vehiclesRoutes = (key: string) =>
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
      return c.json({ vehicleId: vehicleIdOf(key, parsed.data.vin) }, 200);
    });
