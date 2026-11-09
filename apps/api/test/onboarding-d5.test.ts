import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Server } from 'http';
import { decodeJwt } from 'jose';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { DEMO_USER } from '../src/core/demo.js';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { vaultRepo } from '../src/repos/vault.js';

/**
 * D5: a real account must never receive demo identity or simulated money. The demo user is a local-dev fixture only.
 */
describe('D5: no demo identity or fabricated balance for real accounts', () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    initLocalSeed();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') baseUrl = `http://localhost:${a.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const freshUser = () => crypto.randomUUID();
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json: never = null as never;
    try { json = JSON.parse(text) as never; } catch { /* non-JSON body */ }
    return { status: res.status, text, json };
  };
  const GHAZIABAD = '28.6692, 77.4538'; // coordinate pair: geocoded offline
  const onboard = (token: string, extra: Record<string, unknown> = {}) =>
    call(token, 'POST', '/api/onboarding', { address: GHAZIABAD, reachKm: 8, guiltFreeCapMinor: 15000, interests: ['cafes'], ...extra });

  it('a brand-new account is provisioned with its own name, no demo data, and a zero real pocket', async () => {
    const id = freshUser();
    const token = await createDevToken(id, 'priya@example.com', 'Priya Nair');
    expect((await call(token, 'GET', '/api/me')).status).toBe(200); // first request provisions the profile
    const profile = await profilesRepo.getById(id);
    expect(profile?.name).toBe('Priya Nair');
    const pocket = await vaultRepo.getPocket(id, 'weekly');
    expect(pocket).toMatchObject({ balance_minor: 0, is_simulated: false });
  });

  it('onboarding keeps the real name, applies the real timezone and location, and invents no money', async () => {
    const id = freshUser();
    const token = await createDevToken(id, 'priya@example.com', 'Priya Nair');
    const r = await onboard(token, { timezone: 'Asia/Kolkata' });
    expect(r.status).toBe(200);
    const profile = await profilesRepo.getById(id);
    expect(profile).toMatchObject({ name: 'Priya Nair', timezone: 'Asia/Kolkata' });
    expect(profile?.home_lat).toBeCloseTo(28.6692, 3);
    expect(await vaultRepo.getPocket(id, 'weekly')).toMatchObject({ balance_minor: 0, is_simulated: false });
    expect(r.text).not.toMatch(/Aarav|Sharma|aarav@pocketful/);
    expect(r.text).not.toContain('14000');
  });

  it('an explicit name from the sign-up form wins over the token', async () => {
    const id = freshUser();
    const token = await createDevToken(id, 'sam@example.com', 'sam');
    await onboard(token, { name: '  Sam Okoye  ' });
    expect((await profilesRepo.getById(id))?.name).toBe('Sam Okoye');
  });

  it('a token with no name claim falls back to the email handle, never to a demo name', async () => {
    const id = freshUser();
    const token = await createDevToken(id, 'noname@example.com');
    expect(decodeJwt(token)['user_metadata']).toEqual({ name: 'noname' });
    await onboard(token);
    expect((await profilesRepo.getById(id))?.name).toBe('noname');
  });

  it('omitting the timezone leaves the existing one alone', async () => {
    const id = freshUser();
    const token = await createDevToken(id, 'tz@example.com', 'Tz User');
    await call(token, 'GET', '/api/me');
    const before = (await profilesRepo.getById(id))!.timezone;
    await onboard(token);
    expect((await profilesRepo.getById(id))!.timezone).toBe(before);
  });

  it.each(['Mars/Olympus', 'not a zone', '', 'x'.repeat(65)])('rejects the invalid timezone %j', async (tz) => {
    const token = await createDevToken(freshUser(), 'bad@example.com', 'Bad');
    const r = await onboard(token, { timezone: tz });
    expect(r.status).toBe(400);
    expect(r.json['error']['code']).toBe('VALIDATION_FAILED');
  });

  it('rejects an empty name', async () => {
    const token = await createDevToken(freshUser(), 'e@example.com', 'E');
    expect((await onboard(token, { name: '   ' })).status).toBe(400);
  });

  it('if the weekly pocket is somehow missing, onboarding recreates it at ZERO and not simulated', async () => {
    const id = freshUser();
    const token = await createDevToken(id, 'gap@example.com', 'Gap');
    await call(token, 'GET', '/api/me');
    localDb.pockets.delete(`${id}:weekly`);
    expect(await vaultRepo.getPocket(id, 'weekly')).toBeNull();
    await onboard(token);
    expect(await vaultRepo.getPocket(id, 'weekly')).toMatchObject({ balance_minor: 0, is_simulated: false });
  });

  describe('dev tokens', () => {
    it('only the demo email gets the demo name; any other identity gets its own', async () => {
      expect(decodeJwt(await createDevToken())['user_metadata']).toEqual({ name: DEMO_USER.name });
      expect(decodeJwt(await createDevToken(freshUser(), 'jo@example.com'))['user_metadata']).toEqual({ name: 'jo' });
    });
    it('the dev-token endpoint does not stamp the demo name on other emails', async () => {
      const res = await fetch(baseUrl + '/api/auth/dev-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: freshUser(), email: 'lee@example.com' })
      });
      const json = (await res.json()) as { data: { user: { name: string } } };
      expect(res.status).toBe(200);
      expect(json.data.user.name).toBe('lee');
    });
  });

  it('source of truth: the demo identity literal lives in core/demo.ts only (plus the local seed that uses it)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const srcDir = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'), 'src');
    const apiRoot = path.resolve(srcDir, '..');

    function scan(dir: string): string[] {
      const results: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scan(full));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes('Aarav Sharma') || content.includes('aarav@pocketful.demo')) {
            results.push(path.relative(apiRoot, full).replace(/\\/g, '/'));
          }
        }
      }
      return results;
    }

    const hits = scan(srcDir).sort();
    expect(hits).toEqual(['src/core/demo.ts']);
  });
});
