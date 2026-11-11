import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The SPA is served with `script-src 'self'` (render.yaml). If the production build ever emits an inline script or
 * handler, the browser would block it and the app would be a blank page. Build for real and check.
 */
describe('E4: production build is compatible with the SPA CSP', () => {
  it('emits only same-origin external scripts, no inline scripts or inline event handlers', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-build-'));
    await build({ logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf-8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\ssrc="\/assets\//);
      expect(body!.trim()).toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // onclick= etc.
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<(iframe|object|embed)\b/i);
    fs.rmSync(outDir, { recursive: true, force: true });
  }, 90_000);
});
