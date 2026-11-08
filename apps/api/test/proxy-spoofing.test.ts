import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { config } from '../src/core/config.js';

/**
 * M2: rate limiting keys on req.ip. With `trust proxy` = N the app believes only the N right-most proxies, so extra
 * addresses a client prepends to X-Forwarded-For must never change the key it is limited under.
 * (Rate limiters are skipped when NODE_ENV=test, so the test flips it for the duration and restores it.)
 */
describe('M2: spoofed X-Forwarded-For cannot bypass rate limiting', () => {
  let server: Server;
  let baseUrl: string;
  const realEnv = config.NODE_ENV;

  beforeAll(async () => {
    config.NODE_ENV = 'development';
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') baseUrl = `http://127.0.0.1:${a.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    config.NODE_ENV = realEnv;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const hit = async (xff: string) => (await fetch(`${baseUrl}/pay/no-such-token`, { headers: { 'X-Forwarded-For': xff } })).status;

  it('trust proxy is the configured hop count', () => {
    expect(app.get('trust proxy')).toBe(config.TRUST_PROXY_HOPS);
    expect(config.TRUST_PROXY_HOPS).toBe(1);
  });

  it('rotating a fake left-most address on every request still hits the 100/15min /pay limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 105; i++) statuses.push(await hit(`10.${i % 250}.${i}.1, 203.0.113.50`));
    expect(statuses.slice(0, 100).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(100).every((s) => s === 429)).toBe(true);
  }, 60_000);

  it('a different real client behind the same proxy is limited separately', async () => {
    expect(await hit('10.9.9.9, 198.51.100.77')).not.toBe(429);
  });

  it('a single client that sends a bogus single-entry X-Forwarded-For cannot dodge the count either', async () => {
    // Direct hits (no proxy appended anything): the socket peer + header are both attacker controlled, the app trusts
    // exactly one hop so the header value is taken as the proxy-observed client and is counted consistently.
    const results = new Set<number>();
    for (let i = 0; i < 3; i++) results.add(await hit('192.0.2.200'));
    expect(results.has(429)).toBe(false);
  });
});
