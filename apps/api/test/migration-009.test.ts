import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.resolve(__dirname, '../../../supabase/migrations');
const sql = (f: string) => fs.readFileSync(path.join(dir, f), 'utf-8').replace(/\r\n/g, '\n');

describe('migration 009_stepup_hardening.sql', () => {
  it('exists and 001-008 are still present', () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toContain('009_stepup_hardening.sql');
    for (const n of ['001', '002', '003', '004', '005', '006', '007', '008']) expect(files.some((f) => f.startsWith(n))).toBe(true);
  });

  const m = () => sql('009_stepup_hardening.sql');

  it('is idempotent (re-applied by the harness): every DDL statement is guarded', () => {
    const text = m();
    expect(text).not.toMatch(/^\s*create table (?!if not exists)/im);
    expect(text).not.toMatch(/^\s*create index (?!if not exists)/im);
    expect(text).not.toMatch(/alter table \S+ add column (?!if not exists)/i);
    expect(text).toMatch(/create or replace function step_up_register_attempt/i);
  });

  it('adds the cooldown anchor to step_up_credentials', () => {
    expect(m()).toMatch(/alter table step_up_credentials add column if not exists factor_changed_at timestamptz/i);
  });

  it('counts attempts with ONE atomic UPDATE ... RETURNING that refuses to touch a locked row', () => {
    const text = m();
    expect(text).toMatch(/update step_up_credentials[\s\S]+failed_attempts \+ 1[\s\S]+returning/i);
    expect(text).toMatch(/locked_until is null or [a-z_.]*locked_until <= now\(\)/i);
  });

  it('security_notifications is service-role only: RLS on, no policies, client grants revoked', () => {
    const text = m();
    expect(text).toMatch(/create table if not exists security_notifications/i);
    expect(text).toMatch(/alter table security_notifications enable row level security/i);
    expect(text).toMatch(/revoke all on security_notifications from public, anon, authenticated/i);
    expect(text).toMatch(/grant all on security_notifications to service_role/i);
    expect(text).not.toMatch(/create policy[^;]*security_notifications/i);
  });

  it('the attempt function is not callable by client roles', () => {
    expect(m()).toMatch(/revoke all on function step_up_register_attempt\(uuid, boolean, int, int\) from public, anon, authenticated/i);
    expect(m()).toMatch(/grant execute on function step_up_register_attempt\(uuid, boolean, int, int\) to service_role/i);
  });
});
