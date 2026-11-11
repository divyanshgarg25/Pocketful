import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { previewGroupSplit, ApiError } from '../src/lib/api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('E2: the equal-split preview comes from the server', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the total and friend count and returns the server amounts untouched', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, data: { totalMinor: 10001, currency: 'USD', friendShares: [3334, 3334], organizerShareMinor: 3333 } }));
    const out = await previewGroupSplit(10001, 2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/groups/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ totalMinor: 10001, friendCount: 2 });
    expect(out.friendShares).toEqual([3334, 3334]);
    expect(out.organizerShareMinor).toBe(3333);
  });

  it('surfaces a server validation error instead of inventing numbers', async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'bad' } }, 400));
    await expect(previewGroupSplit(0, 2)).rejects.toBeInstanceOf(ApiError);
  });

  it('can be cancelled with an AbortSignal so a stale response never lands', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const p = previewGroupSplit(1000, 2, controller.signal);
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(ApiError);
  });
});

describe('E2: no second split algorithm in the web app', () => {
  const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '../src', f), 'utf-8');
  it('lib/money no longer exports splitEqual', () => {
    expect(read('lib/money.ts')).not.toMatch(/splitEqual/);
  });
  it('GroupScreen derives equal shares only from previewGroupSplit, never locally', () => {
    const src = read('screens/GroupScreen.tsx');
    expect(src).toMatch(/previewGroupSplit/);
    expect(src).not.toMatch(/splitEqual/);
    // the old local fallback: Math.round(totalAmount / participants)
    expect(src).not.toMatch(/Math\.round\(totalAmount\s*\/\s*total/);
    // staging is blocked until a server preview is present (equal mode)
    expect(src).toMatch(/!equalReady/);
  });
});
