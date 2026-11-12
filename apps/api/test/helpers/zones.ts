/** Shared by the JS boundary test and the real-Postgres parity test, so both check the SAME zones and instants.
 *  Note: America/Havana is excluded because Cuba's late-2026 DST rule differs between Node 22's bundled tzdata (2025b)
 *  and the Postgres 16 container's newer tzdata. */
export const WEEK_TEST_ZONES = [
  'UTC', 'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'America/St_Johns', 'America/Toronto', 'America/Santiago',
  'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Africa/Cairo', 'Asia/Beirut', 'Asia/Tehran', 'Asia/Kolkata', 'Asia/Kathmandu',
  'Asia/Tokyo', 'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'
];

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Instants across 2025-2027 plus dense coverage of the usual DST-change fortnights. */
export function weekTestInstants(): number[] {
  const r = rng(20261108);
  const out: number[] = [];
  for (let i = 0; i < 14; i++) out.push(Date.UTC(2025, 0, 1) + Math.floor(r() * 3 * 365 * 86_400_000));
  for (const [m, d] of [[2, 8], [2, 15], [2, 22], [2, 29], [3, 1], [3, 5], [9, 25], [9, 28], [10, 1], [10, 4], [10, 25], [10, 28]]) {
    for (let k = 0; k < 2; k++) out.push(Date.UTC(2026, m, d + Math.floor(r() * 4), Math.floor(r() * 24), Math.floor(r() * 4) * 15));
  }
  return out;
}

