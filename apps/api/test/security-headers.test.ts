import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import app from '../src/index.js';

describe('E4: security headers', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    await new Promise<void>((r) => {
      server = app.listen(0, () => {
        const a = server.address();
        if (a && typeof a === 'object') base = `http://localhost:${a.port}`;
        r();
      });
    });
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const directives = (csp: string) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

  it('API sends a deny-everything CSP on success AND error responses', async () => {
    for (const p of ['/health', '/api/does-not-exist', '/api/vault']) {
      const res = await fetch(base + p);
      const d = directives(res.headers.get('content-security-policy') ?? '');
      expect(d['default-src'], p).toEqual(["'none'"]);
      expect(d['frame-ancestors'], p).toEqual(["'none'"]);
      expect(d['base-uri'], p).toEqual(["'none'"]);
      expect(res.headers.get('x-content-type-options'), p).toBe('nosniff');
    }
  });

  describe('SPA headers in render.yaml (the static host is where they are actually served)', () => {
    const yaml = fs.readFileSync(path.resolve(__dirname, '../../../render.yaml'), 'utf-8').replace(/\r\n/g, '\n');
    const web = yaml.slice(yaml.indexOf('name: pocketful-web'));
    const header = (name: string) => new RegExp(`name: ${name}\\n\\s+value: "?([^\\n]*?)"?\\n`).exec(web)?.[1];
    const csp = directives(header('Content-Security-Policy') ?? '');

    it('script-src allows only same-origin: no unsafe-inline, unsafe-eval or remote scripts', () => {
      expect(csp['script-src']).toEqual(["'self'"]);
    });
    it('locks down objects, base, forms and framing', () => {
      expect(csp['object-src']).toEqual(["'none'"]);
      expect(csp['base-uri']).toEqual(["'self'"]);
      expect(csp['form-action']).toEqual(["'self'"]);
      expect(csp['frame-ancestors']).toEqual(["'none'"]);
      expect(csp['upgrade-insecure-requests']).toEqual([]);
    });
    it('never uses a wildcard or unsafe-inline for scripts or connections', () => {
      for (const d of ['default-src', 'script-src', 'connect-src']) {
        expect(csp[d]!.join(' '), d).not.toMatch(/'unsafe-(inline|eval)'|(^| )\*( |$)|https:( |$)/);
      }
    });
    it("connect-src allows exactly this deployment's API (VITE_API_URL) and Supabase", () => {
      const api = /VITE_API_URL\n\s+value: (\S+)/.exec(web)?.[1];
      expect(api).toBeTruthy();
      expect(csp['connect-src']).toContain(api);
      expect(csp['connect-src']).toContain('https://*.supabase.co');
    });
    it('allows only the Google Fonts the stylesheet imports; inline styles only as attributes', () => {
      expect(csp['style-src']).toEqual(["'self'", 'https://fonts.googleapis.com']);
      expect(csp['style-src-attr']).toEqual(["'unsafe-inline'"]);
      expect(csp['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com']);
    });
    it('also sets HSTS, nosniff, referrer policy, and keeps WebAuthn available to the app only', () => {
      expect(header('X-Content-Type-Options')).toBe('nosniff');
      expect(header('Strict-Transport-Security')).toMatch(/max-age=\d{7,}/);
      expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      const pp = header('Permissions-Policy') ?? '';
      expect(pp).toContain('publickey-credentials-get=(self)');
      expect(pp).toContain('camera=()');
    });
  });
});
