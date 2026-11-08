import { Hono } from 'hono';
import { openDb, type Db } from './db/index.js';
import { tripsRoutes } from './routes/trips.js';
import { resolveVehicleHmacKey, vehiclesRoutes } from './routes/vehicles.js';

// RPC 타입 추론을 위해 라우트는 반드시 체이닝으로 정의한다.
export const createApp = (db: Db = openDb(), options: { vehicleHmacKey?: string } = {}) =>
  new Hono()
    .get('/health', (c) => c.json({ ok: true as const }))
    .route('/trips', tripsRoutes(db))
    .route('/vehicles', vehiclesRoutes(options.vehicleHmacKey ?? resolveVehicleHmacKey(), db));

export type AppType = ReturnType<typeof createApp>;
