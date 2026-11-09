import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { deriveRegion } from '../src/routes/occasions.js';

describe('M3: deriveRegion never silently falls back to US-CA', () => {
  it('returns null when nothing identifies a region', () => {
    expect(deriveRegion(null, null, null)).toBeNull();
    expect(deriveRegion(undefined, undefined, undefined)).toBeNull();
    expect(deriveRegion('', '', '')).toBeNull();
    expect(deriveRegion('Europe/Moscow', 'RUB', 'Somewhere')).toBeNull();
    expect(deriveRegion('Africa/Nairobi', 'KES', null)).toBeNull();
  });

  it('does not guess a US state from the currency or a generic America/* zone alone', () => {
    expect(deriveRegion(null, 'USD', null)).toBeNull();
    expect(deriveRegion('America/Denver', 'USD', null)).toBeNull();
    expect(deriveRegion('America/Sao_Paulo', null, null)).toBeNull();
  });

  it('still maps the regions it can really identify', () => {
    expect(deriveRegion('Asia/Kolkata', 'INR', null)).toBe('IN');
    expect(deriveRegion('Europe/London', 'GBP', null)).toBe('GB');
    expect(deriveRegion('Europe/Paris', 'EUR', null)).toBe('EU');
    expect(deriveRegion('America/Toronto', 'CAD', null)).toBe('CA');
    expect(deriveRegion('Australia/Sydney', 'AUD', null)).toBe('AU');
    expect(deriveRegion('Asia/Tokyo', 'JPY', null)).toBe('JP');
    expect(deriveRegion('America/Los_Angeles', 'USD', null)).toBe('US-CA');
    expect(deriveRegion('America/New_York', 'USD', null)).toBe('US-NY');
    expect(deriveRegion('America/Chicago', 'USD', null)).toBe('US-IL');
    expect(deriveRegion(null, null, 'Mission District, San Francisco')).toBe('US-CA');
  });
});

describe('M3: the occasions API reports a clear "set your region" state', () => {
  let server: Server;
  let baseUrl: string;
  const userId = '00000000-0000-4000-a000-0000000000d3';
  let token: string;
  const get = async (p: string) => {
    const r = await fetch(baseUrl + p, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, json: (await r.json()) as { ok: boolean; data: Record<string, unknown>; error?: { code: string; message: string } } };
  };

  beforeAll(async () => {
    initLocalSeed();
    token = await createDevToken(userId, 'region@pocketful.demo', 'Region');
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') baseUrl = `http://localhost:${a.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(async () => {
    await get('/api/me'); // provisions the profile
    const p = localDb.profiles.get(userId)!;
    p.timezone = 'Europe/Moscow';
    p.home_label = 'Nowhere in particular';
    p.currency = 'USD';
  });

  it('GET /api/occasions: region null, regionRequired true, a human message, and no holidays from a guessed calendar', async () => {
    const r = await get('/api/occasions');
    expect(r.status).toBe(200);
    expect(r.json.data['region']).toBeNull();
    expect(r.json.data['regionRequired']).toBe(true);
    expect(String(r.json.data['regionMessage'])).toMatch(/region/i);
    const cal = r.json.data['calendar'] as Array<{ type: string }>;
    expect(cal.some((c) => c.type === 'holiday')).toBe(false);
    expect(cal.length).toBeGreaterThan(0); // the everyday + weekend items still work
  });

  it('GET /api/occasions: a derivable region keeps working and reports it', async () => {
    localDb.profiles.get(userId)!.timezone = 'America/Los_Angeles';
    const r = await get('/api/occasions');
    expect(r.json.data['region']).toBe('US-CA');
    expect(r.json.data['regionRequired']).toBe(false);
  });

  it('POST /api/getaways/plan: refuses with 422 REGION_REQUIRED instead of planning from a guessed region', async () => {
    const r = await fetch(`${baseUrl}/api/getaways/plan`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nights: 2 }) });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('REGION_REQUIRED');
  });
});
