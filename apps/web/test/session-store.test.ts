import { describe, it, expect } from 'vitest';
import { createSessionStore, decodeJwtPayload, isTokenExpired, purgeLegacyStorage, TOKEN_KEY, USER_KEY } from '../src/lib/sessionStore';

class FakeStorage {
  private m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
  key = (i: number) => [...this.m.keys()][i] ?? null;
  get length() { return this.m.size; }
  keys = () => [...this.m.keys()];
}

const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
// Shaped like a real Supabase access token: long payload whose base64url contains '-' and '_'.
const supabaseLike = (exp: number) =>
  jwt({ aud: 'authenticated', exp, sub: '00000000-0000-4000-a000-000000000001', email: 'aarav@pocketful.demo', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: { name: 'Zoë ??>>' } });
const user = { id: 'u1', email: 'a@b.c', name: 'A' };

describe('E4: session store', () => {
  describe('JWT decoding (regression: atob rejects base64url)', () => {
    it('decodes a realistic token whose payload contains - and _, including non-ASCII', () => {
      const t = supabaseLike(inOneHour());
      expect(t.split('.')[1]).toMatch(/[-_]/);
      expect(() => atob(t.split('.')[1]!)).toThrow(); // the old implementation
      expect(decodeJwtPayload(t)?.['email']).toBe('aarav@pocketful.demo');
      expect((decodeJwtPayload(t)?.['user_metadata'] as { name: string }).name).toBe('Zoë ??>>');
    });
    it('a valid unexpired realistic token is NOT reported expired', () => {
      expect(isTokenExpired(supabaseLike(inOneHour()))).toBe(false);
    });
    it('reports expired, malformed, exp-less and non-numeric-exp tokens as expired (fail closed)', () => {
      expect(isTokenExpired(supabaseLike(Math.floor(Date.now() / 1000) - 1))).toBe(true);
      for (const bad of ['', 'abc', 'a.b', 'a.!!!.c', 'a.e30.c', jwt({ exp: '9999999999' }), jwt({})]) {
        expect(isTokenExpired(bad), bad).toBe(true);
      }
    });
    it('honours a clock-skew margin', () => {
      const t = jwt({ exp: Math.floor(Date.now() / 1000) + 30 });
      expect(isTokenExpired(t)).toBe(false);
      expect(isTokenExpired(t, Date.now(), 60_000)).toBe(true);
    });
  });

  describe('storage', () => {
    it('keeps the session in the primary store and NEVER writes to the legacy (localStorage) store', () => {
      const session = new FakeStorage();
      const local = new FakeStorage();
      const store = createSessionStore(session, local);
      const t = supabaseLike(inOneHour());
      store.set(t, user);
      expect(store.getToken()).toBe(t);
      expect(store.getUser()).toEqual(user);
      expect(session.keys().sort()).toEqual([TOKEN_KEY, USER_KEY].sort());
      expect(local.keys()).toEqual([]);
    });

    it('clears an expired token (and its user) when it is read', () => {
      const session = new FakeStorage();
      const store = createSessionStore(session, null);
      store.set(supabaseLike(Math.floor(Date.now() / 1000) - 10), user);
      expect(store.getToken()).toBeNull();
      expect(store.getUser()).toBeNull();
      expect(session.keys()).toEqual([]);
    });

    it('getUser is null without a live token and tolerates corrupt user JSON', () => {
      const session = new FakeStorage();
      const store = createSessionStore(session, null);
      session.setItem(USER_KEY, JSON.stringify(user));
      expect(store.getUser()).toBeNull();
      session.setItem(TOKEN_KEY, supabaseLike(inOneHour()));
      session.setItem(USER_KEY, '{not json');
      expect(store.getUser()).toBeNull();
    });

    it('clear() removes the session', () => {
      const session = new FakeStorage();
      const store = createSessionStore(session, null);
      store.set(supabaseLike(inOneHour()), user);
      store.clear();
      expect(store.getToken()).toBeNull();
      expect(session.keys()).toEqual([]);
    });

    it('falls back to memory when sessionStorage is unavailable', () => {
      const store = createSessionStore(null, null);
      store.set(supabaseLike(inOneHour()), user);
      expect(store.getUser()).toEqual(user);
    });
  });

  describe('legacy localStorage purge (old builds left tokens there)', () => {
    it('removes our old keys and Supabase sessions, leaves unrelated keys alone', () => {
      const local = new FakeStorage();
      local.setItem(TOKEN_KEY, 'old-token');
      local.setItem(USER_KEY, '{}');
      local.setItem('sb-abcdefgh-auth-token', '{"refresh_token":"r"}');
      local.setItem('sb-abcdefgh-auth-token-code-verifier', 'v');
      local.setItem('theme', 'dark');
      createSessionStore(new FakeStorage(), local);
      expect(local.keys()).toEqual(['theme']);
    });

    it('survives blocked storage', () => {
      const blocked = { get length(): number { throw new Error('blocked'); }, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
      expect(() => createSessionStore(new FakeStorage(), blocked as never)).not.toThrow();
      expect(() => purgeLegacyStorage(null)).not.toThrow();
    });
  });
});
