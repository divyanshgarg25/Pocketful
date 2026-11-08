import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8').replace(/\r\n/g, '\n');

/** Event types the webhook handler really processes, read from the source (never from a hand-kept list). */
function handledEvents(): string[] {
  const src = read('apps/api/src/routes/webhooks.ts');
  return [...new Set([...src.matchAll(/'((?:PAYMENT|CHECKOUT)\.[A-Z_.]+)'/g)].map((m) => m[1]!))].sort();
}

describe('M5: PayPal webhook docs match the handler', () => {
  it('the handler processes both PAYMENT.CAPTURE.COMPLETED and CHECKOUT.ORDER.COMPLETED', () => {
    expect(handledEvents()).toEqual(['CHECKOUT.ORDER.COMPLETED', 'PAYMENT.CAPTURE.COMPLETED']);
  });

  it.each(['README.md', 'SECURITY.md', 'render.yaml'])('%s names every handled webhook event', (file) => {
    const text = read(file);
    for (const ev of handledEvents()) expect(text, `${file} is missing ${ev}`).toContain(ev);
  });

  it('README tells operators to subscribe to BOTH events when creating the webhook', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('Setting Up PayPal Sandbox'), readme.indexOf('Setting Up PayPal Sandbox') + 1500);
    expect(section).toContain('PAYMENT.CAPTURE.COMPLETED');
    expect(section).toContain('CHECKOUT.ORDER.COMPLETED');
  });
});

describe('docs drift: new environment variables are documented', () => {
  it.each(['STEPUP_ENROLL_COOLDOWN_HOURS', 'TRUST_PROXY_HOPS'])('%s is in .env.example, render.yaml (where deployed) and SECURITY.md', (k) => {
    expect(read('.env.example')).toContain(k);
    expect(read('SECURITY.md')).toContain(k);
    expect(read('render.yaml')).toContain(k);
  });

  it('README lists migration 009 and SECURITY.md describes the cooldown and fresh-session rule', () => {
    expect(read('README.md')).toContain('009_stepup_hardening.sql');
    expect(read('SECURITY.md')).toMatch(/fresh session/i);
    expect(read('SECURITY.md')).toMatch(/cooldown/i);
  });
});
