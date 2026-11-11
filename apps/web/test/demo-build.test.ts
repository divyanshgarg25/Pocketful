import { describe, it, expect, afterEach } from 'vitest';
import { build } from 'vite';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DEMO_STRINGS = ['weekend-ledger-2026', 'aarav@pocketful.demo', 'Aarav', '1-Click Demo', '/api/auth/dev-token'];

function bundleText(outDir: string): string {
  const dir = path.join(outDir, 'assets');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
    .join('\n');
}

async function buildTo(): Promise<string> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-demo-'));
  await build({ logLevel: 'silent', mode: 'production', build: { outDir, emptyOutDir: true } });
  return outDir;
}

describe('D5: the demo identity cannot ship in a production bundle', () => {
  const prev = process.env['VITE_ENABLE_DEMO'];
  afterEach(() => {
    if (prev === undefined) delete process.env['VITE_ENABLE_DEMO'];
    else process.env['VITE_ENABLE_DEMO'] = prev;
  });

  it('a default production build contains none of the demo credentials, names or the demo endpoint', async () => {
    delete process.env['VITE_ENABLE_DEMO'];
    const out = await buildTo();
    const text = bundleText(out);
    for (const s of DEMO_STRINGS) expect(text.includes(s), s).toBe(false);
    // no pre-assumed San Francisco coordinates for real users (the one remaining "San Francisco" is placeholder text)
    expect(text.includes('37.7749')).toBe(false);
    expect(text.includes('-122.4194') || text.includes('122.4194')).toBe(false);
    fs.rmSync(out, { recursive: true, force: true });
  }, 90_000);

  it('positive control: a build that opts in with VITE_ENABLE_DEMO=true does contain them (so the check above is not vacuous)', async () => {
    process.env['VITE_ENABLE_DEMO'] = 'true';
    const out = await buildTo();
    const text = bundleText(out);
    for (const s of DEMO_STRINGS) expect(text.includes(s), s).toBe(true);
    fs.rmSync(out, { recursive: true, force: true });
  }, 90_000);
});
