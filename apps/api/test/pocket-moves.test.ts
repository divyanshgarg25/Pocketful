import { describe, it, expect, beforeEach } from 'vitest';
import { initLocalSeed, localDb } from '../src/core/database.js';
import { vaultRepo } from '../src/repos/vault.js';

const u = '00000000-0000-4000-a000-000000000001';
const total = () => {
  let t = 0;
  for (const [k, p] of localDb.pockets) if (k.startsWith(`${u}:`)) t += p.balance_minor;
  const v = localDb.vault.get(u);
  return t + (v ? v.goal_balance_minor + v.rollover_balance_minor : 0);
};

describe('Atomic pocket/vault moves never create or destroy money (B6)', () => {
  beforeEach(() => {
    initLocalSeed();
    localDb.pockets.clear();
    localDb.vault.clear();
    localDb.pockets.set(`${u}:weekly`, { user_id: u, kind: 'weekly', balance_minor: 10000, target_minor: null, is_simulated: true });
  });

  it('moving to a pocket that does not exist creates it (previously the money vanished)', async () => {
    const r = await vaultRepo.movePocketBalance(u, 'weekly', 'holiday', 2500);
    expect(r.ok).toBe(true);
    expect(localDb.pockets.get(`${u}:holiday`)?.balance_minor).toBe(2500);
    expect(localDb.pockets.get(`${u}:weekly`)?.balance_minor).toBe(7500);
    expect(total()).toBe(10000);
  });

  it('insufficient balance / bad args change nothing', async () => {
    expect(await vaultRepo.movePocketBalance(u, 'weekly', 'holiday', 10001)).toMatchObject({ ok: false, code: 'INSUFFICIENT' });
    expect(await vaultRepo.movePocketBalance(u, 'weekly', 'weekly', 5)).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(await vaultRepo.movePocketBalance(u, 'weekly', 'holiday', -5)).toMatchObject({ ok: false });
    expect(await vaultRepo.movePocketBalance(u, 'weekly', 'holiday', 1.5)).toMatchObject({ ok: false });
    expect(await vaultRepo.moveWeeklyToVault(u, 'lock_in', 0)).toMatchObject({ ok: false });
    expect(total()).toBe(10000);
  });

  it('vault moves debit the pocket and credit the right bucket in one step', async () => {
    await vaultRepo.moveWeeklyToVault(u, 'lock_in', 3000);
    await vaultRepo.moveWeeklyToVault(u, 'roll_over', 2000);
    expect(localDb.vault.get(u)).toMatchObject({ goal_balance_minor: 3000, rollover_balance_minor: 2000 });
    expect(localDb.pockets.get(`${u}:weekly`)?.balance_minor).toBe(5000);
    expect(total()).toBe(10000);
  });

  it('50 concurrent mixed moves: total conserved, no pocket ever negative, never over-spends', async () => {
    const ops = Array.from({ length: 50 }, (_, i) =>
      i % 3 === 0 ? vaultRepo.moveWeeklyToVault(u, i % 2 ? 'lock_in' : 'roll_over', 700)
      : i % 3 === 1 ? vaultRepo.movePocketBalance(u, 'weekly', i % 2 ? 'holiday' : 'getaway', 900)
      : vaultRepo.movePocketBalance(u, 'holiday', 'weekly', 300)
    );
    const results = await Promise.all(ops);
    expect(results.some((r) => r.ok)).toBe(true);
    for (const [k, p] of localDb.pockets) if (k.startsWith(`${u}:`)) expect(p.balance_minor).toBeGreaterThanOrEqual(0);
    expect(total()).toBe(10000);
  });
});
