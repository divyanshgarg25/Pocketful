import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import app from '../src/index.js';
import { createDevToken } from '../src/core/auth.js';
import { profilesRepo } from '../src/repos/profiles.js';
import { UpstreamError, handleRouteError, redactForLog, safeErrorSummary } from '../src/core/errors.js';

let server: Server; let base = '';
beforeAll(async () => { await new Promise<void>((r) => { server = app.listen(0, () => { base = `http://localhost:${(server.address() as any).port}`; r(); }); }); });
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const fakeRes = () => { const r: any = { code: 0, body: null }; r.status = (c: number) => { r.code = c; return r; }; r.json = (b: unknown) => { r.body = b; return r; }; return r; };

describe('D1 information leak', () => {
  it('unknown errors return 500 INTERNAL_ERROR "Something went wrong." with requestId, never err.message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    handleRouteError(res, new Error('secret db password'), 'req_1');
    expect(res.code).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId: 'req_1' });
    expect(JSON.stringify(res.body)).not.toContain('secret db password');
    spy.mockRestore();
  });
  it('UpstreamError is a generic 502; upstream body and details stay out of the response', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = fakeRes();
    handleRouteError(res, new UpstreamError('[PayPal] 401 {"access_token":"A21AAxyz"}', { body: 'Bearer abc.def.ghi' }), 'req_2');
    expect(res.code).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/A21AA|PayPal|Bearer/);
    spy.mockRestore();
  });
  it('end-to-end: a thrown internal error on a real route never reaches the body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const uid = crypto.randomUUID();
    const token = await createDevToken(uid, 'a@b.test', 'T');
    await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } }); // provision
    const orig = profilesRepo.getById.bind(profilesRepo);
    let n = 0;
    const s = vi.spyOn(profilesRepo, 'getById').mockImplementation(async (id: string) => { if (n++ > 0) throw new Error('secret db password'); return orig(id); });
    const r = await fetch(`${base}/api/me/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ optInMood: true }) });
    s.mockRestore(); spy.mockRestore();
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('secret db password');
  });
  it('redactForLog truncates to 500 chars and strips tokens; safeErrorSummary hides internals', () => {
    expect(redactForLog('x'.repeat(2000)).length).toBe(500);
    expect(redactForLog('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def');
    expect(safeErrorSummary(new Error('secret db password'))).toEqual({ code: 'INTERNAL_ERROR', message: 'Execution failed.' });
    expect(safeErrorSummary(new UpstreamError('body: secret'))).not.toHaveProperty('secret');
  });
});
