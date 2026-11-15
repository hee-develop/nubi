import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /health', () => {
  it('200과 { ok: true }를 돌려준다', async () => {
    const res = await createApp(undefined, { vehicleHmacKey: 'test-key' }).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
