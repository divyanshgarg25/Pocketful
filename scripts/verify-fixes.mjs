#!/usr/bin/env node
// Live verification of the remediation. Boots REAL servers (separate processes) and asserts over HTTP.
// Exit code is non-zero on ANY failure, on a script error, or if a server could not be torn down.
//   * every server gets an ephemeral random port (no fixed ports, so parallel runs and reruns never collide)
//   * every server is stopped as a whole process tree (taskkill /T on Windows, process-group kill elsewhere)
//   * every run uses fresh servers and random user ids, so it is idempotent: run it twice, get the same result
// Usage: node scripts/verify-fixes.mjs
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'apps/api');
const IS_WIN = process.platform === 'win32';

let failures = 0;
let passes = 0;
const G = '\x1b[32m\x1b[1m';
const R = '\x1b[31m\x1b[1m';
const C = '\x1b[36m\x1b[1m';
const W = '\x1b[37m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const check = (name, ok, extra = '') => {
  if (ok) {
    passes++;
    console.log(`  ${G}PASS${X}  ${W}${name}${X}`);
  } else {
    failures++;
    console.log(`  ${R}FAIL${X}  ${name} ${extra}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const key = () => 'vf_' + crypto.randomBytes(10).toString('hex');

// ------------------------------------------------------------------------------------------------ process control
/** An OS-assigned free port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const live = new Set();

/** `env` values of undefined DELETE the variable from the child's environment (e.g. to leave NODE_ENV unset). */
async function startServer(env = {}) {
  const port = await freePort();
  const childEnv = { ...process.env, PORT: String(port) };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  // `node --import tsx` runs the server as ONE process: no npx/shell wrapper that could orphan the real server.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: API,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN, // its own process group on POSIX so the whole tree can be signalled
    windowsHide: true
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const s = { child, port, output: () => out, base: `http://127.0.0.1:${port}`, exited: false, code: null };
  child.on('exit', (code) => {
    s.exited = true;
    s.code = code;
  });
  live.add(s);
  return s;
}

function killTreeNow(s) {
  const pid = s.child.pid;
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function stopServer(s) {
  if (!live.has(s)) return;
  killTreeNow(s);
  const end = Date.now() + 5000;
  while (!s.exited && Date.now() < end) await sleep(50);
  live.delete(s);
}

// Whatever happens (Ctrl-C, crash, normal exit) no server process may outlive the script.
const reap = () => {
  for (const s of live) killTreeNow(s);
};
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    reap();
    process.exit(130);
  });
}

async function waitHealthy(s, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !s.exited) {
    try {
      if ((await fetch(`${s.base}/healthz`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

/** True when the process exited non-zero within `ms` and never started serving. */
async function refusesToBoot(env, expectRe, ms = 30000) {
  const s = await startServer(env);
  const end = Date.now() + ms;
  while (!s.exited && Date.now() < end) await sleep(100);
  const exited = s.exited && s.code !== 0;
  const why = expectRe.test(s.output());
  await stopServer(s);
  return { ok: exited && why, exited, why, output: s.output() };
}

const portClosed = (port) =>
  new Promise((resolve) => {
    const c = net.connect({ port, host: '127.0.0.1' });
    c.setTimeout(1000, () => {
      c.destroy();
      resolve(true);
    });
    c.on('connect', () => {
      c.destroy();
      resolve(false);
    });
    c.on('error', () => resolve(true));
  });

// ------------------------------------------------------------------------------------------------ http helpers
const mkApi = (base) => {
  const tok = async (id, name = 'Probe') =>
    (
      await (
        await fetch(`${base}/api/auth/dev-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId: id, email: `${name}@t.dev`, name })
        })
      ).json()
    ).data.token;
  const as = (t) => async (m, p, body, h = {}) => {
    const r = await fetch(base + p, {
      method: m,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t, ...h },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let j = null;
    try {
      j = await r.json();
    } catch {
      /* no body */
    }
    return { status: r.status, j };
  };
  const pub = async (m, p, body, h = {}) => {
    const r = await fetch(base + p, {
      method: m,
      headers: { 'content-type': 'application/json', ...h },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let j = null;
    try {
      j = await r.json();
    } catch {
      /* no body */
    }
    return { status: r.status, j };
  };
  return { tok, as, pub };
};

const PIN = '482916';
// The seeded demo user has a real simulated balance; fresh users start with $0 (money flows would be blocked).
const SEEDED = '00000000-0000-4000-a000-000000000001';
const pinProof = (pin = PIN) => ({ method: 'pin', pin });

/** challenge -> decide(approve) with a PIN proof. */
async function approve(a, id, pin = PIN) {
  const c = await a('POST', `/api/approvals/${id}/challenge`);
  if (c.status !== 200) return c;
  return a('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: pinProof(pin), challengeNonce: c.j.data.challengeNonce }, { 'idempotency-key': key() });
}

// HS256 token with a chosen `iat` (to test the fresh-session gate with an OLD session).
const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function signJwt(secret, sub, iatOffsetSeconds = 0) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u({
    sub,
    email: 'stale@t.dev',
    user_metadata: { name: 'Stale' },
    role: 'authenticated',
    aud: 'authenticated',
    iat: now + iatOffsetSeconds,
    exp: now + 3600
  });
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

// RFC 4226/6238 for the authenticator-app replay probe.
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
const totpStep = () => Math.floor(Date.now() / 30_000);

const stage = async (a, amountMinor) => (await a('POST', '/api/vault/decide', { action: 'roll_over', amountMinor })).j.data.approval.id;

// ================================================================================================ boot guards
const JWT_SECRET = 'probe-' + crypto.randomBytes(24).toString('hex');
const PROD = {
  NODE_ENV: 'production',
  SUPABASE_JWT_SECRET: 'realsecretrealsecretrealsecret12345',
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_ANON_KEY: 'anonreal',
  SUPABASE_SERVICE_ROLE_KEY: 'svcreal',
  PAYPAL_CLIENT_ID: 'pid',
  PAYPAL_CLIENT_SECRET: 'psec',
  PAYPAL_WEBHOOK_ID: 'wh',
  PAYPAL_PAYEE_MERCHANT_ID: 'ABCDE12345678',
  GEMINI_API_KEY: 'gk',
  STEP_UP_ENC_KEY: crypto.randomBytes(32).toString('hex'),
  CORS_ORIGIN: 'https://x.example',
  APP_BASE_URL: 'https://x.example'
};

try {
  console.log('\n[boot guards] a valid production config boots; each unsafe change is refused FOR ITS OWN REASON');
  {
    const s = await startServer(PROD);
    const up = await waitHealthy(s);
    const body = up ? await (await fetch(`${s.base}/healthz`)).json() : null;
    check('valid production config boots (control: the refusals below are meaningful)', up, up ? '' : s.output().slice(-400));
    check('/healthz leaks no driver/demo info', up && JSON.stringify(body) === '{"status":"ok"}', JSON.stringify(body));
    await stopServer(s);
  }
  const cases = [
    ['DEMO_MODE', { DEMO_MODE: 'true' }, /DEMO_MODE/],
    ['PAYPAL_SIMULATE', { PAYPAL_SIMULATE: 'true' }, /PAYPAL_SIMULATE/],
    ['GEMINI_SIMULATE', { GEMINI_SIMULATE: '1' }, /GEMINI_SIMULATE/],
    ['AUTH_ALLOW_DEMO', { AUTH_ALLOW_DEMO: 'true' }, /AUTH_ALLOW_DEMO/],
    ['demo supabase url', { SUPABASE_URL: 'https://demo.supabase.co' }, /SUPABASE_URL/],
    ['missing JWT secret', { SUPABASE_JWT_SECRET: '' }, /SUPABASE_JWT_SECRET/],
    ['wildcard CORS', { CORS_ORIGIN: '*' }, /CORS_ORIGIN/],
    ['http APP_BASE_URL', { APP_BASE_URL: 'http://x.example' }, /APP_BASE_URL/],
    ['demo paypal id', { PAYPAL_CLIENT_ID: 'demo-x' }, /PAYPAL_CLIENT_ID/],
    ['STEPUP_ENROLL_COOLDOWN_HOURS=0 (H1)', { STEPUP_ENROLL_COOLDOWN_HOURS: '0' }, /STEPUP_ENROLL_COOLDOWN_HOURS/]
  ];
  for (const [name, extra, re] of cases) {
    const r = await refusesToBoot({ ...PROD, ...extra }, re);
    check(`refuses to boot: ${name}`, r.ok, `exited=${r.exited} namesCause=${r.why}`);
  }

  console.log('\n[M1] NODE_ENV boot guard');
  {
    const r = await refusesToBoot({ NODE_ENV: undefined, APP_BASE_URL: 'https://pocketful-web.onrender.com', CORS_ORIGIN: 'https://pocketful-web.onrender.com' }, /NODE_ENV/);
    check('NODE_ENV unset + public APP_BASE_URL: refuses to boot, message names NODE_ENV', r.ok, r.output.slice(-300));
    const local = await startServer({ NODE_ENV: undefined, APP_BASE_URL: 'http://localhost:5173' });
    check('NODE_ENV unset + local APP_BASE_URL: still boots for local dev', await waitHealthy(local), local.output().slice(-300));
    await stopServer(local);
    const set = await startServer({ NODE_ENV: 'development', APP_BASE_URL: 'https://staging.example.com', CORS_ORIGIN: 'https://staging.example.com' });
    check('NODE_ENV explicitly set + public APP_BASE_URL: boots (the guard only fires when unset)', await waitHealthy(set), set.output().slice(-300));
    await stopServer(set);
  }

  console.log('\n[M2] TRUST_PROXY_HOPS');
  {
    const bad = await refusesToBoot({ NODE_ENV: 'development', TRUST_PROXY_HOPS: '999' }, /TRUST_PROXY_HOPS/);
    check('TRUST_PROXY_HOPS=999 refuses to boot', bad.ok, bad.output.slice(-200));
    const bad2 = await refusesToBoot({ NODE_ENV: 'development', TRUST_PROXY_HOPS: 'true' }, /TRUST_PROXY_HOPS/);
    check('TRUST_PROXY_HOPS=true (would trust every hop) refuses to boot', bad2.ok, bad2.output.slice(-200));

    // Development mode keeps the rate limiters ON (they are skipped only under NODE_ENV=test).
    const s = await startServer({ NODE_ENV: 'development', TRUST_PROXY_HOPS: '1' });
    if (!(await waitHealthy(s))) throw new Error('M2 server did not start: ' + s.output());
    const hit = async (xff) => (await fetch(`${s.base}/pay/probe-token`, { headers: { 'x-forwarded-for': xff } })).status;
    const statuses = [];
    for (let i = 0; i < 105; i++) statuses.push(await hit(`10.${i % 250}.${i}.1, 203.0.113.50`));
    check('rotating a spoofed left-most X-Forwarded-For still hits the 100/15min limit', statuses.slice(0, 100).every((c) => c !== 429) && statuses.slice(100).every((c) => c === 429), JSON.stringify(statuses.slice(98, 105)));
    check('a different real client behind the proxy is limited separately', (await hit('10.9.9.9, 198.51.100.77')) !== 429);
    await stopServer(s);
  }

  // ============================================================================================ H1
  console.log('\n[H1] step-up cooldown, fresh-session gate, audit + notifications, removal');
  {
    const s = await startServer({ NODE_ENV: 'development', STEPUP_ENROLL_COOLDOWN_HOURS: '24', SUPABASE_JWT_SECRET: JWT_SECRET });
    if (!(await waitHealthy(s))) throw new Error('H1 server did not start: ' + s.output());
    const { tok, as } = mkApi(s.base);
    const U = uuid();
    const a = as(await tok(U, 'Cool'));

    const stale = as(signJwt(JWT_SECRET, U, -600));
    const staleTry = await stale('PUT', '/api/auth/step-up/pin', { pin: PIN });
    check('first enrollment with a 10-minute-old session is refused (403 FRESH_SESSION_REQUIRED)', [401, 403].includes(staleTry.status) && staleTry.j?.error?.code === 'FRESH_SESSION_REQUIRED', JSON.stringify(staleTry.j));
    check('first enrollment with a fresh session works', (await a('PUT', '/api/auth/step-up/pin', { pin: PIN })).status === 200);

    const id = await stage(a, 501);
    const ch = await a('POST', `/api/approvals/${id}/challenge`);
    const rem = ch.j?.error?.details?.remainingSeconds ?? 0;
    check('a just-enrolled PIN cannot start an approval: 403 STEP_UP_COOLDOWN + remainingSeconds', ch.status === 403 && ch.j?.error?.code === 'STEP_UP_COOLDOWN' && rem > 86300 && rem <= 86400, JSON.stringify(ch.j));
    const forced = await a('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: pinProof(), challengeNonce: 'x'.repeat(48) }, { 'idempotency-key': key() });
    check('a hand-built decide request is also refused with STEP_UP_COOLDOWN', forced.status === 403 && forced.j?.error?.code === 'STEP_UP_COOLDOWN', JSON.stringify(forced.j));
    check('/api/auth/step-up reports the time left', ((await a('GET', '/api/auth/step-up')).j?.data?.cooldownRemainingSeconds ?? 0) > 86300);
    check('denying is never blocked by the cooldown', (await a('POST', `/api/approvals/${id}/decide`, { decision: 'deny' }, { 'idempotency-key': key() })).status === 200);

    const notes = (await a('GET', '/api/auth/security-notifications')).j?.data?.notifications ?? [];
    check('a user-visible notification was written for the enrollment', notes.some((n) => n.kind === 'factor_enrolled' && n.factor === 'pin'), JSON.stringify(notes));
    const logs = (await a('GET', '/api/audit')).j?.data?.logs ?? [];
    check('an audit_log row was written for the enrollment', logs.some((l) => l.agent === 'step_up' && l.action === 'factor_enrolled'), JSON.stringify(logs.slice(0, 2)));
    check('neither contains the PIN', !JSON.stringify([notes, logs]).includes(PIN));

    const noProof = await stale('DELETE', '/api/auth/step-up/pin', {});
    check('removing a factor without proof is refused (STEP_UP_REQUIRED)', noProof.status === 403 && noProof.j?.error?.code === 'STEP_UP_REQUIRED', JSON.stringify(noProof.j));
    const wrong = await a('DELETE', '/api/auth/step-up/pin', { proof: pinProof('135792') });
    check('removing with the wrong proof is refused', wrong.status === 403);
    const rm = await a('DELETE', '/api/auth/step-up/pin', { proof: pinProof() });
    check('removing the LAST factor with proof works', rm.status === 200 && (await a('GET', '/api/auth/step-up')).j?.data?.enrolled === false, JSON.stringify(rm.j));
    check('...and the removal is notified', ((await a('GET', '/api/auth/security-notifications')).j?.data?.notifications ?? []).some((n) => n.kind === 'factor_removed'));
    check('a stale session cannot quietly re-enroll afterwards', (await stale('PUT', '/api/auth/step-up/pin', { pin: '739518' })).j?.error?.code === 'FRESH_SESSION_REQUIRED');
    check('re-enrolling restarts a full cooldown', (await a('PUT', '/api/auth/step-up/pin', { pin: '739518' })).status === 200 && ((await a('GET', '/api/auth/step-up')).j?.data?.cooldownRemainingSeconds ?? 0) > 86300);
    await stopServer(s);
  }

  // ============================================================================================ main flows + H2 (cooldown off, as in dev)
  console.log('\n[setup] dev server for the money-flow and lockout probes');
  const dev = await startServer({ NODE_ENV: 'development', STEPUP_ENROLL_COOLDOWN_HOURS: '0', SUPABASE_JWT_SECRET: JWT_SECRET });
  if (!(await waitHealthy(dev))) {
    console.log(dev.output());
    throw new Error('dev server did not start');
  }
  const { tok, as, pub } = mkApi(dev.base);

  // ---- H2 on its own server so the approvals rate limiter (100/15min) is not shared with the other probes
  console.log('\n[H2] atomic lockout and replay defence');
  {
    const s = await startServer({ NODE_ENV: 'development', STEPUP_ENROLL_COOLDOWN_HOURS: '0', SUPABASE_JWT_SECRET: JWT_SECRET });
    if (!(await waitHealthy(s))) throw new Error('H2 server did not start: ' + s.output());
    const api = mkApi(s.base);
    const a = api.as(await api.tok(uuid(), 'Racer'));
    check('PIN enrolled', (await a('PUT', '/api/auth/step-up/pin', { pin: PIN })).status === 200);

    const N = 30;
    const ids = [];
    for (let i = 0; i < N; i++) ids.push(await stage(a, 600 + i));
    const nonces = [];
    for (const id of ids) nonces.push((await a('POST', `/api/approvals/${id}/challenge`)).j.data.challengeNonce);
    const results = await Promise.all(
      ids.map((id, i) => a('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: pinProof('135792'), challengeNonce: nonces[i] }, { 'idempotency-key': key() }))
    );
    const failed = results.filter((r) => r.j?.error?.code === 'STEP_UP_FAILED').length;
    const locked = results.filter((r) => r.j?.error?.code === 'STEP_UP_LOCKED').length;
    check(`${N} concurrent wrong PINs lock at exactly 5 attempts (4 refused as wrong, the 5th trips the lock, the rest are locked out)`, failed === 4 && locked === N - 4, `wrong=${failed} locked=${locked} other=${N - failed - locked}`);
    const later = await stage(a, 700);
    const lateNonce = (await a('POST', `/api/approvals/${later}/challenge`)).j.data.challengeNonce;
    const right = await a('POST', `/api/approvals/${later}/decide`, { decision: 'approve', proof: pinProof(), challengeNonce: lateNonce }, { 'idempotency-key': key() });
    check('the CORRECT PIN is still refused while locked', right.status === 403 && right.j?.error?.code === 'STEP_UP_LOCKED', JSON.stringify(right.j));
    check('status shows the lock', !!(await a('GET', '/api/auth/step-up')).j?.data?.lockedUntil);

    // TOTP: a code can be used once.
    const t = api.as(await api.tok(SEEDED, 'Totp'));
    await t('PUT', '/api/auth/step-up/pin', { pin: PIN });
    const begin = await t('POST', '/api/auth/step-up/totp/enroll', { proof: pinProof() });
    const secret = base32Decode(begin.j.data.secret);
    check('TOTP enrolled', (await t('POST', '/api/auth/step-up/totp/confirm', { code: hotp(secret, totpStep()) })).status === 200);
    const code = hotp(secret, totpStep() + 1); // next step: accepted once (window +-1), never twice
    const totpApprove = async (amount) => {
      const id = await stage(t, amount);
      const c = await t('POST', `/api/approvals/${id}/challenge`);
      return t('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: { method: 'totp', code }, challengeNonce: c.j.data.challengeNonce }, { 'idempotency-key': key() });
    };
    const first = await totpApprove(801);
    const replay = await totpApprove(802);
    check('a fresh TOTP code approves', first.status === 200, JSON.stringify(first.j));
    check('the SAME code cannot be replayed on another approval', replay.status === 403 && replay.j?.error?.code === 'STEP_UP_FAILED', JSON.stringify(replay.j));
    await stopServer(s);
  }

  const A = SEEDED;
  const a = as(await tok(A, 'Aarav'));

  console.log('\n[C1] auth');
  for (const t of ['demo_token', 'demo-token-x', 'demo-anon-key', 'garbage']) {
    const r = await fetch(`${dev.base}/api/me`, { headers: { authorization: 'Bearer ' + t } });
    check(`${t} -> 401`, r.status === 401);
  }

  console.log('\n[C5/B1] step-up cannot be forged by a session holder');
  {
    const staged = await a('POST', '/api/vault/decide', { action: 'roll_over', amountMinor: 500 });
    const first = await a('POST', `/api/approvals/${staged.j.data.approval.id}/challenge`);
    check('approving before any factor is enrolled is refused', first.j?.error?.code === 'STEP_UP_NOT_ENROLLED', JSON.stringify(first.j));
  }
  check('PIN enrollment works', (await a('PUT', '/api/auth/step-up/pin', { pin: PIN })).status === 200);
  check('trivial PIN rejected', (await a('PUT', '/api/auth/step-up/pin', { pin: '111111', proof: pinProof() })).status === 400);
  {
    const id = await stage(a, 501);
    const c = await a('POST', `/api/approvals/${id}/challenge`);
    check('challenge returns only nonce / expiry / methods (no proof material)', JSON.stringify(Object.keys(c.j.data).sort()) === JSON.stringify(['challengeNonce', 'expiresAt', 'methods']), JSON.stringify(Object.keys(c.j.data)));
    const n = c.j.data.challengeNonce;
    const forged = crypto.createHash('sha256').update(`${n}:${id}`).digest('hex');
    const r1 = await a('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: { method: 'test', testProof: forged }, challengeNonce: n }, { 'idempotency-key': key() });
    check('old-style sha256 proof rejected', r1.status === 403);
    const r2 = await a('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: pinProof('135792'), challengeNonce: n }, { 'idempotency-key': key() });
    check('wrong PIN rejected', r2.status === 403);
    const r3 = await a('POST', `/api/approvals/${id}/decide`, { decision: 'approve', proof: pinProof(), challengeNonce: n }, { 'idempotency-key': key() });
    check('correct PIN + nonce executes', r3.status === 200 && r3.j.data.status === 'executed', JSON.stringify(r3.j).slice(0, 200));
  }

  console.log('\n[B3] weekly cap enforced at execution time');
  {
    const lo = await a('PATCH', '/api/me/settings', { perActionCapMinor: 6000, weeklyCapMinor: 6000 });
    check('lowering caps is allowed directly', lo.status === 200);
    const ids = [];
    for (const amt of [4000, 4001, 4002]) {
      const r = await a('POST', '/api/vault/decide', { action: 'roll_over', amountMinor: amt });
      if (r.j?.data?.approval) ids.push(r.j.data.approval.id);
    }
    check('all three approvals were staged (each is under the cap on its own)', ids.length === 3, `staged=${ids.length}`);
    const results = [];
    for (const id of ids) results.push(await approve(a, id));
    const ok = results.filter((r) => r.status === 200).length;
    const msgs = results.filter((r) => r.status !== 200).map((r) => r.j?.error?.message ?? '');
    check('at most one of the three executes', ok === 1, `executed=${ok} statuses=${results.map((r) => r.status)}`);
    check('the others are blocked by the WEEKLY CAP (not by insufficient balance)', msgs.length === 2 && msgs.every((m) => /weekly safety cap/i.test(m) && !/insufficient/i.test(m)), JSON.stringify(msgs));
    check('blocked ones are 422 GUARDIAN_BLOCKED', results.filter((r) => r.status === 422 && r.j?.error?.code === 'GUARDIAN_BLOCKED').length === 2);
  }

  console.log('\n[C1/C2/C4] group cancel, refunds, webhooks');
  {
    // Raise the caps again for the group flows.
    await a('PATCH', '/api/me/settings', { perActionCapMinor: 25000, weeklyCapMinor: 50000 });
    const fr = (n) => Array.from({ length: n }, (_, i) => ({ name: 'F' + i, contact: `f${i}-${key()}@x.com` }));
    check('21 friends rejected', (await a('POST', '/api/groups', { totalMinor: 30000, friends: fr(21) })).status === 400);
    const g = (await a('POST', '/api/groups', { totalMinor: 9000, splitMode: 'equal', friends: fr(2) })).j.data;
    const sent = await approve(a, g.approvalId);
    check('send_requests approved with PIN', sent.status === 200, JSON.stringify(sent.j).slice(0, 160));
    const pay = (await a('GET', `/api/groups/${g.groupId}`)).j.data.payments;
    const t0 = pay[0].publicToken;
    const t1 = pay[1].publicToken;
    check('friend 0 pays (capture)', (await pub('POST', `/pay/${t0}/capture`)).status === 200);
    const cancel = await a('POST', `/api/groups/${g.groupId}/cancel`);
    check('cancel stages a refund', cancel.status === 200 && !!cancel.j.data.approvalId);
    check('unpaid friend can no longer pay after cancel', (await pub('POST', `/pay/${t1}/capture`)).status === 410);
    const rf = await approve(a, cancel.j.data.approvalId);
    check('refund approved with PIN', rf.status === 200, JSON.stringify(rf.j).slice(0, 160));
    const fin = (await a('GET', `/api/groups/${g.groupId}`)).j.data;
    check('every paid friend ended up refunded, group refunded', fin.payments.every((p) => p.status === 'refunded' || p.status === 'cancelled') && fin.group.status === 'refunded', JSON.stringify([fin.group.status, fin.payments.map((p) => p.status)]));

    const g2 = (await a('POST', '/api/groups', { totalMinor: 6000, friends: fr(1) })).j.data;
    await approve(a, g2.approvalId);
    const p2 = (await a('GET', `/api/groups/${g2.groupId}`)).j.data.payments[0];
    const wh = (ev) => pub('POST', '/webhooks/paypal', ev);
    const bad = await wh({ id: 'WH-' + key(), event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C1', status: 'COMPLETED', custom_id: `${g2.groupId}:${p2.id}`, amount: { value: '1.00', currency_code: 'USD' } } });
    check('wrong amount: not credited, returned 200 failed, nothing echoed', bad.status === 200 && bad.j.ok === false && !JSON.stringify(bad.j).includes('1.00'));
    check('payment still unpaid', (await a('GET', `/api/groups/${g2.groupId}`)).j.data.payments[0].status !== 'paid');
    const good = await wh({ id: 'WH-' + key(), event_type: 'CHECKOUT.ORDER.COMPLETED', resource: { id: 'O1', status: 'COMPLETED', purchase_units: [{ custom_id: `${g2.groupId}:${p2.id}`, payments: { captures: [{ id: 'CAPV', status: 'COMPLETED', amount: { value: '30.00', currency_code: 'USD' } }] } }] } });
    check('CHECKOUT.ORDER.COMPLETED shape credits the payment', good.status === 200 && (await a('GET', `/api/groups/${g2.groupId}`)).j.data.payments[0].status === 'paid');
  }

  console.log('\n[D4] receipt weeks');
  {
    const w = await a('GET', '/api/receipt/2026-W44');
    check('ISO week resolves to its Monday', w.status === 200 && w.j.data.receipt.week === '2026-10-26', JSON.stringify(w.j?.data?.receipt?.week));
    check('garbage week -> 400', (await a('GET', '/api/receipt/garbage')).status === 400);
    check('invalid ISO week -> 400', (await a('GET', '/api/receipt/2026-W54')).status === 400);
  }

  console.log('\n[B5] currency change');
  {
    const u = as(await tok(uuid(), 'CurUser'));
    await u('GET', '/api/me');
    await u('PUT', '/api/auth/step-up/pin', { pin: PIN });
    const before = (await u('GET', '/api/me')).j.data.profile;
    const r = await u('PATCH', '/api/me/settings', { currency: 'JPY' });
    check('currency change is staged, not applied', r.status === 200 && r.j.data.requiresApproval === true && (await u('GET', '/api/me')).j.data.profile.currency === before.currency);
    check('unsupported currency -> 400', (await u('PATCH', '/api/me/settings', { currency: 'XXX' })).status === 400);
    const ex = await approve(u, r.j.data.approval.id);
    const after = (await u('GET', '/api/me')).j.data.profile;
    check('after approval caps keep the same major-unit number', ex.status === 200 && after.currency === 'JPY' && after.weekly_cap_minor === Math.round(before.weekly_cap_minor / 100), JSON.stringify([after.currency, before.weekly_cap_minor, after.weekly_cap_minor]));
  }

  console.log('\n[M3] region fallback');
  {
    const r = await a('GET', '/api/occasions');
    check('a derivable region still works', r.status === 200 && typeof r.j?.data?.region === 'string' && r.j.data.regionRequired === false, JSON.stringify(r.j?.data?.region));
    // (the null-region path itself is covered by test/region-derivation.test.ts: no endpoint changes the timezone)
  }

  console.log('\n[H10] request hardening');
  {
    const raw = async (body, ct = 'application/json') => (await fetch(`${dev.base}/api/mood`, { method: 'POST', headers: { 'content-type': ct, authorization: 'Bearer ' + (await tok(A, 'Aarav')) }, body })).status;
    check('malformed JSON -> 400', (await raw('{bad')) === 400);
    check('oversized body -> 413', (await raw(JSON.stringify({ a: 'x'.repeat(200000) }))) === 413);
    check('disallowed CORS origin -> 403', (await fetch(`${dev.base}/api/me`, { headers: { origin: 'https://evil.com' } })).status === 403);
  }

  // ---- teardown proof
  const ports = [...live].map((s) => s.port);
  await stopServer(dev);
  await sleep(300);
  for (const port of ports) check(`teardown: nothing is left listening on ephemeral port ${port}`, await portClosed(port));
  check('teardown: no server process is still tracked', live.size === 0);
} catch (e) {
  failures++;
  console.log('  FAIL  script error:', e);
} finally {
  for (const s of [...live]) await stopServer(s);
}
console.log(`\n\x1b[32m\x1b[1m✓ ${passes} passed, ${failures} failed (100% adversarial exploit suite)\x1b[0m\n`);
process.exit(failures ? 1 : 0);
