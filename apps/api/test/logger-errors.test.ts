import { describe, it, expect, vi, afterEach } from 'vitest';
import { z, ZodError } from 'zod';
import { logger } from '../src/core/logger.js';
import { handleRouteError } from '../src/core/errors.js';

afterEach(() => vi.restoreAllMocks());

const fakeRes = () => {
  const out: { status?: number; body?: { error?: { code: string; details?: Array<{ path: string }> } } } = {};
  const res = {
    status(n: number) { out.status = n; return res; },
    json(b: never) { out.body = b; return res; },
    setHeader() { return res; }
  };
  return { res: res as never, out };
};

describe('logger.error', () => {
  it('does not invent an "undefined" error detail when no error object is given', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('something', undefined, { requestId: 'r1' });
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: 'ERROR', message: 'something', requestId: 'r1' });
    expect('errorDetails' in line).toBe(false);
    expect(JSON.stringify(line)).not.toContain('undefined');
  });

  it('treats a plain object in the error position as CONTEXT, so call sites like logger.error(msg, { eventId }) keep their fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('[PayPal Webhook] ALERT capture rejected', { eventId: 'evt_1', code: 'DECLINED' });
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: 'ERROR', eventId: 'evt_1', code: 'DECLINED' });
    expect(JSON.stringify(line)).not.toContain('[object Object]');
    expect('errorDetails' in line).toBe(false);
  });

  it('an explicit 3rd-argument context still wins and an Error in 2nd position is still an error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom', new Error('bad'), { requestId: 'r9' });
    expect(JSON.parse(spy.mock.calls[0]![0] as string)).toMatchObject({ errorMessage: 'bad', requestId: 'r9' });
  });

  it('still records the name, message and stack of a real Error, and a stringified non-Error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom', new TypeError('bad'));
    logger.error('weird', 'just a string');
    const [a, b] = spy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(a).toMatchObject({ errorName: 'TypeError', errorMessage: 'bad' });
    expect(a.stack).toContain('TypeError');
    expect(b.errorDetails).toBe('just a string');
  });
});

describe('handleRouteError with validation errors', () => {
  it('returns 400 with dotted paths for a normal Zod error', () => {
    const r = z.object({ a: z.object({ b: z.number() }) }).safeParse({ a: { b: 'x' } });
    const { res, out } = fakeRes();
    handleRouteError(res, (r as { error: ZodError }).error, 'req1');
    expect(out.status).toBe(400);
    expect(out.body?.error?.details?.[0]?.path).toBe('a.b');
  });

  it('does not crash when an issue path contains a symbol (join() would throw a TypeError)', () => {
    const err = new ZodError([{ code: 'custom', message: 'bad', path: ['a', Symbol('k') as unknown as string] }]);
    const { res, out } = fakeRes();
    expect(() => handleRouteError(res, err, 'req2')).not.toThrow();
    expect(out.status).toBe(400);
    expect(out.body?.error?.details?.[0]?.path).toMatch(/^a\.Symbol\(k\)$/);
  });
});
