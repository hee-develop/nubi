import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const KEY = 'test-key';
const VIN = 'KMHABCDEF12345678';

describe('vehicles', () => {
  it('vehicleId는 HMAC-SHA256(서버 키, VIN) hex이고 같은 VIN은 항상 같다', async () => {
    const app = createApp(openDb(':memory:'), { vehicleHmacKey: KEY });
    const a = await app.request('/vehicles/register', json({ vin: VIN }));
    const b = await app.request('/vehicles/register', json({ vin: VIN }));
    const other = await app.request('/vehicles/register', json({ vin: 'OTHERVIN' }));
    expect(a.status).toBe(200);
    const expected = createHmac('sha256', KEY).update(VIN).digest('hex');
    expect(await a.json()).toEqual({ vehicleId: expected });
    expect(await b.json()).toEqual({ vehicleId: expected });
    expect(((await other.json()) as { vehicleId: string }).vehicleId).not.toBe(expected);
    // 서버 키가 다르면 같은 VIN도 다른 ID(키 없이는 VIN 사전 공격으로 되돌릴 수 없다)
    const app2 = createApp(openDb(':memory:'), { vehicleHmacKey: 'other-key' });
    const c = (await (await app2.request('/vehicles/register', json({ vin: VIN }))).json()) as { vehicleId: string };
    expect(c.vehicleId).not.toBe(expected);
  });

  it('잘못된 요청은 400이고 입력 값을 응답에 되돌려 주지 않는다', async () => {
    const app = createApp(openDb(':memory:'), { vehicleHmacKey: KEY });
    for (const body of [{}, { vin: '' }, { vin: 123 }, { vin: 'x'.repeat(65) }]) {
      const res = await app.request('/vehicles/register', json(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect((await app.request('/vehicles/register', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('VIN을 DB에도 로그에도 남기지 않는다(스키마에 vin 열 없음, 모든 테이블 값에도 없음)', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const db = openDb(':memory:');
    const app = createApp(db, { vehicleHmacKey: KEY });
    const reg = (await (await app.request('/vehicles/register', json({ vin: VIN }))).json()) as { vehicleId: string };
    const start = await app.request(
      '/trips',
      json({ localId: 'l1', vehicleId: reg.vehicleId, driverId: reg.vehicleId, startedAt: '2026-11-08T00:00:00Z' }),
    );
    expect(start.status).toBe(201);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(
        cols.some((c) => /vin/i.test(c)),
        `${t} 테이블에 vin 열`,
      ).toBe(false);
      expect(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).not.toContain(VIN);
    }
    const list = await (await app.request('/trips')).text();
    expect(list).not.toContain(VIN);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(VIN);
    spies.forEach((s) => s.mockRestore());
  });
});

describe('local_id 복합 UNIQUE', () => {
  it('다른 차량이 같은 localId를 써도 서로 다른 트립이고, 같은 차량은 멱등', async () => {
    const app = createApp(openDb(':memory:'), { vehicleHmacKey: KEY });
    const start = (vehicleId: string) =>
      app.request('/trips', json({ localId: 'same', vehicleId, driverId: vehicleId, startedAt: '2026-11-08T00:00:00Z' }));
    const a1 = await start('va');
    const b1 = await start('vb');
    const a2 = await start('va');
    expect(a1.status).toBe(201);
    expect(b1.status).toBe(201);
    expect(a2.status).toBe(200);
    const ida = ((await a1.json()) as { tripId: string }).tripId;
    expect(((await a2.json()) as { tripId: string }).tripId).toBe(ida);
    expect(((await b1.json()) as { tripId: string }).tripId).not.toBe(ida);
    expect(((await (await app.request('/trips')).json()) as { trips: unknown[] }).trips).toHaveLength(2);
  });

  it('local_id 단독 UNIQUE였던 기존 DB를 열면 복합 UNIQUE로 마이그레이션하고 기존 행은 보존한다', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nubi-mig-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE trips (id TEXT PRIMARY KEY, local_id TEXT, vehicle_id TEXT NOT NULL, driver_id TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, odometer_start_km REAL, odometer_end_km REAL, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_trips_local_id ON trips (local_id);
      INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, created_at) VALUES ('t1', 'l1', 'va', 'va', 'x', 'y');`);
    old.close();
    const db = openDb(path);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trips'").all() as { name: string }[]).map(
      (i) => i.name,
    );
    expect(idx).toContain('idx_trips_vehicle_local_id');
    expect(idx).not.toContain('idx_trips_local_id');
    // 이제 같은 localId를 다른 차량이 쓸 수 있다
    db.prepare(
      "INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, created_at) VALUES ('t2', 'l1', 'vb', 'vb', 'x', 'y')",
    ).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM trips').get()).toEqual({ n: 2 });
    // 같은 차량의 같은 localId는 여전히 막힌다
    expect(() =>
      db
        .prepare(
          "INSERT INTO trips (id, local_id, vehicle_id, driver_id, started_at, created_at) VALUES ('t3', 'l1', 'va', 'va', 'x', 'y')",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe('End 멱등과 오도미터 보충', () => {
  it('처음 End의 오도미터가 null이었고 나중 End에 값이 있으면 채우되 종료 시각은 그대로 둔다', async () => {
    const app = createApp(openDb(':memory:'), { vehicleHmacKey: KEY });
    const res = await app.request('/trips', json({ localId: 'e1', vehicleId: 'v', driverId: 'v', startedAt: '2026-11-08T00:00:00Z' }));
    const tripId = ((await res.json()) as { tripId: string }).tripId;
    await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-08T00:01:00Z', odometerEndKm: null }));
    const mid = (await (await app.request(`/trips/${tripId}`)).json()) as { endedAt: string; odometerEndKm: number | null };
    expect(mid.odometerEndKm).toBeNull();
    await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-08T00:09:00Z', odometerEndKm: 42.5 }));
    const filled = (await (await app.request(`/trips/${tripId}`)).json()) as { endedAt: string; odometerEndKm: number | null };
    expect(filled.odometerEndKm).toBe(42.5);
    expect(filled.endedAt).toBe('2026-11-08T00:01:00.000Z');
    // 이미 값이 있으면 덮어쓰지 않는다
    await app.request(`/trips/${tripId}/end`, json({ endedAt: '2026-11-08T00:10:00Z', odometerEndKm: 99 }));
    const after = (await (await app.request(`/trips/${tripId}`)).json()) as { odometerEndKm: number | null };
    expect(after.odometerEndKm).toBe(42.5);
  });
});
