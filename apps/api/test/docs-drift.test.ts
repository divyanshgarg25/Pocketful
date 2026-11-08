import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8').replace(/\r\n/g, '\n');

/** Keys declared in the config schema: every `  KEY:` line inside the `z.object({ ... })` env block. */
function schemaKeys(): string[] {
  const src = read('apps/api/src/core/config.ts');
  const start = src.indexOf('z.object({');
  const end = src.indexOf('\n});', start);
  return [...src.slice(start, end).matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
}
const envExampleKeys = (): string[] => [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);

describe('E5: docs match the code', () => {
  it('parses a sensible number of config keys (guards the parser itself)', () => {
    const keys = schemaKeys();
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toEqual(expect.arrayContaining(['DEFAULT_CURRENCY', 'STEP_UP_ENC_KEY', 'WEBAUTHN_RP_ID', 'CORS_ORIGIN']));
  });

  it('every config variable is documented in .env.example (uncommented or as a commented example)', () => {
    const doc = new Set(envExampleKeys());
    expect(schemaKeys().filter((k) => !doc.has(k))).toEqual([]);
  });

  it('.env.example documents no variable the API ignores', () => {
    const known = new Set(schemaKeys());
    expect(envExampleKeys().filter((k) => !known.has(k) && !k.startsWith('VITE_'))).toEqual([]);
  });

  it('README lists every migration file, in numeric order', () => {
    const readme = read('README.md');
    const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.filter((f) => !readme.includes(f))).toEqual([]);
    const positions = files.map((f) => readme.indexOf(f));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('README does not claim things that are no longer (or never were) true', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/WebAuthn\/passkeys are \*\*not\*\* implemented/i);
    expect(readme).not.toMatch(/\d+ passing tests/); // a hard-coded count is wrong the moment a test is added
    expect(readme).not.toMatch(/All mutation endpoints require an `Idempotency-Key`/);
  });

  it('SECURITY.md reflects the implemented step-up and CSP', () => {
    const sec = read('SECURITY.md');
    expect(sec).not.toMatch(/No WebAuthn\/passkeys yet/i);
    expect(sec).not.toMatch(/CSP in the API's helmet config is currently disabled/i);
    expect(sec).toMatch(/passkey/i);
    expect(sec).toMatch(/STEP_UP_ENC_KEY/);
    expect(sec).toMatch(/sessionStorage/);
  });

  it('the README endpoint summary mentions every step-up and group-preview route that exists', () => {
    const readme = read('README.md');
    for (const r of ['/api/auth/step-up', '/api/auth/passkeys/register/options', '/api/auth/step-up/totp/enroll', '/api/groups/preview']) {
      expect(readme, r).toContain(r);
    }
  });
});
