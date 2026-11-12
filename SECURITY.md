# Pocketful Security & Threat Model Specification

## 1. Security Architecture & Threat Model

Pocketful manages user lifestyle spending, group splits, and subscription management. To ensure money integrity and prevent unauthorized execution, the system is designed around a **Zero-Trust AI / Deterministic Guardian** architecture.

### 1.1 The Untrusted Advisor Model
- **Large Language Models (Gemini)** are treated strictly as **untrusted suggestion generators**.
- LLMs **CANNOT**:
  - Move money or execute payments.
  - Approve transactions or alter financial caps.
  - Directly access or delete user database records.
- All LLM outputs pass through strict Zod runtime validation schemas with non-negative bounds and integrity checks before ingestion.

### 1.2 The Deterministic Guardian Gatekeeper
Every state mutation involving money, subscriptions, or caps requires explicit progression through the Guardian state machine:
1. **Integer Minor Units Invariant**: All currency arithmetic is strictly integer minor units (e.g. cents, pence, paise). Floating-point math is banned.
2. **Weekly Mon-00:00:00 Cap Boundary**: Weekly spending caps reset strictly at Monday 00:00:00 in the user's configured IANA timezone.
3. **Atomic, cap-checked execution**: State transitions `pending -> approved -> executing -> executed | failed` are guarded by a DB trigger. Starting execution goes through one atomic step (`begin_execution` on Postgres, a per-user mutex locally) that re-checks the user's *current* per-action and weekly caps, counting approvals already `executing` or `executed` this week. Caps are therefore enforced at execution time, not just when an approval is staged, so many approvals staged under the cap cannot jointly exceed it. A cap of `0` blocks any action that moves money out.
4. **Step-up with a bound single-use challenge**: Approve and retry both require proof from a real factor, bound to the exact approval. The server issues a 5-minute single-use nonce and stores it with a fingerprint of everything being approved (`sha256(approvalId | userId | action_type | amount | money_out | canonical(payload) | expires_at)`). The user proves it with, in order of preference:
   - **a passkey (WebAuthn, primary)**: the authenticator signs `sha256("pocketful-stepup-v1" | nonce | fingerprint)`; user verification is required, the origin and RP ID are checked, and the signature counter is advanced by compare-and-swap. A signature for one approval is worthless for any other.
   - **an authenticator-app code (TOTP, RFC 6238)**: the secret is sealed with AES-256-GCM (`STEP_UP_ENC_KEY`) and each 30-second step can be used once.
   - **the PIN** (scrypt-hashed).
   PIN and TOTP share **one** failure counter (5 failures lock both for 15 minutes), so alternating factors cannot multiply guesses. Passkeys are not guessable and keep working during a lockout, so a stolen session cannot lock the real user out of approving. The nonce is consumed with an atomic compare-and-swap after the factor verifies, so two concurrent requests can never both spend it. The challenge endpoint returns no value from which a proof can be derived, so a stolen session token alone cannot approve an action. Retry additionally re-checks caps, is limited to 3 attempts within 24 hours, and is refused for any approval whose action already happened (its outcome is persisted *before* the status write, and a failure after the side effect never marks the approval `failed`).
5. **Idempotency Key Validation**: Financial endpoints enforce 16–128 character idempotency keys (`Idempotency-Key` or `x-idempotency-key`) preventing replay attacks.
6. **Append-Only Immutable Audit Log**: Database triggers prevent `UPDATE` or `DELETE` on `audit_log` and `approval_events`, and `UPDATE`, `DELETE` or `TRUNCATE` on the `settlements` money ledger. The single permitted change is nulling a settlement's pseudonymous `organizer_id` when that account is erased (the amounts stay).

---

## 2. API Hardening & Middleware Invariants

1. **Fail-Closed Boot Guard**: The API refuses to start in production if demo credentials, missing JWT secrets, or demo simulator flags are detected.
2. **Strict CORS Allowlist**: Only explicitly whitelisted origins configured in `CORS_ORIGIN` are accepted.
3. **HTTP Security Headers**: The API (JSON only) sends a deny-everything CSP (`default-src 'none'; frame-ancestors 'none'`), `nosniff` and the other `helmet` defaults. The web app is a static site, so its headers come from `render.yaml`: a CSP with `script-src 'self'` (no inline or `eval`), `object-src 'none'`, `frame-ancestors 'none'`, `connect-src` limited to this deployment's API and Supabase, plus HSTS, `nosniff`, a referrer policy and a Permissions-Policy that allows WebAuthn for the app only. Tests parse `render.yaml` and build the SPA to check both.
4. **Body Size Limits**:
   - Standard JSON APIs: Strict `100kb` limit.
   - Webhook Ingestion: `1mb` raw limit with cryptographic PayPal signature verification.
5. **Tiered Rate Limiting**: Dedicated rate limiting prevents brute-force attacks and abuse:
   - General API: 1000 requests / 15-minute window (`/api`).
   - Payment checkout: 100 requests / 15-minute window (`/pay`).
   - Webhook ingestion: 200 requests / 15-minute window (`/webhooks`).
   - Approvals execution: 100 requests / 15-minute window (`/api/approvals`).

### 2.1 Payee & Settlement Model
Friend payments are collected into the **platform's PayPal merchant account**; there is no organizer payout in this codebase (see README §3.4 for the full model and the legal note). Captures are reconciled through `settlePayment()` using `custom_id = "<groupId>:<paymentId>"`, with fail-closed amount, currency and payee checks (orders name `PAYPAL_PAYEE_MERCHANT_ID` as the receiver; production refuses to boot without it) and a compare-and-swap status transition. Subscribe the PayPal webhook to both `PAYMENT.CAPTURE.COMPLETED` and `CHECKOUT.ORDER.COMPLETED`; both are verified (signature) and settled through the same function. Every capture and refund is also written to the append-only `settlements` ledger. Money captured for something no longer payable is refunded automatically, and expired group outings refund paid friends automatically without waiting for the organizer.

### 2.2 Known limitations (read before going live)
- **First step-up factor needs a fresh session.** Nothing exists to prove against, so enrolling the *first* passkey/TOTP/PIN is allowed with the session alone, but only when the token's `iat` is within the last 5 minutes (`403 FRESH_SESSION_REQUIRED` otherwise): a token lifted from an old tab or log cannot claim the account's step-up. Once any factor exists, adding, changing or removing a factor requires proof from an existing one (`STEP_UP_REQUIRED` otherwise). Passkeys, the authenticator app and the PIN can each be removed (`DELETE /api/auth/passkeys/:id`, `/api/auth/step-up/totp`, `/api/auth/step-up/pin`); removing the last factor also needs proof and restarts the cooldown below.
- **Enrollment cooldown.** A factor that was just enrolled, replaced or reset cannot approve money actions for `STEPUP_ENROLL_COOLDOWN_HOURS` (default 24 in production and enforced to be at least 1 by the boot guard; 0 in development and tests). Blocked requests get `403 STEP_UP_COOLDOWN` with `error.details.remainingSeconds`; denying an approval is never blocked. Every enrollment, replacement and removal writes an `audit_log` row (agent `step_up`) and a `security_notifications` row that the You screen shows, so the real owner has the whole window to notice. Accounts whose factors predate migration 009 have no cooldown anchor and are not retroactively blocked.
- **Attempt counting is atomic.** PIN and TOTP share one counter (5 wrong attempts lock both for 15 minutes). PostgreSQL decides it in one `UPDATE ... RETURNING` (`step_up_register_attempt()`, migration 009) and the in-memory driver does the same under a per-user async mutex, so concurrent guesses cannot be under-counted and a correct code in flight cannot unlock a locked account. TOTP accepts each 30-second step once (stored last step, advanced by compare-and-swap) and passkey signature counters may only move forward (compare-and-swap; 0 -> 0 is allowed for authenticators that never count).
- **`NODE_ENV` must be explicit on a public host.** If `NODE_ENV` is unset and `APP_BASE_URL` is not a local address the API refuses to boot rather than silently running as `development`.
- **`TRUST_PROXY_HOPS`** (default 1, an integer 0-10, never `true`) is how many reverse proxies sit in front of the API. Rate limiting keys on the client IP Express derives from `X-Forwarded-For`, so a value that is too high lets clients spoof the header to dodge limits and one that is too low makes everyone share the proxy's IP. Render's single proxy means 1.
- **Step-up configuration.** Production refuses to boot without `STEP_UP_ENC_KEY` (64 hex chars; rotating it invalidates enrolled authenticator apps), with `STEP_UP_TEST_MODE=true`, or with a `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` that is not an https origin under the app's own domain. `STEP_UP_TEST_MODE` enables a software authenticator for tests and is impossible in production (config guard plus a second runtime check).
- **Group outings do not consume the weekly cap.** `send_requests` is modelled as money-in (friend reimbursements), so the organizer's own share is not counted toward the weekly cap. The per-action cap check still applies at staging time.
- **Pockets and vault are simulated ledgers** (`is_simulated = true`); moving "fun money" does not move real funds.
- **Session tokens are readable by script in the page.** They are kept in `sessionStorage` (tab-scoped, gone when the tab closes; the Supabase refresh token is stored there too and nothing is left in `localStorage`, which older builds' leftovers are purged from), so a stolen browser profile or storage dump stays useful for less time. This does **not** stop injected script from reading them: the CSP above is the control for that, and a fully script-proof session would need httpOnly cookies behind a backend-for-frontend, which this design does not have. Consequence: a new browser tab asks you to sign in again. If you use a custom Supabase domain, update `connect-src` in `render.yaml`.
- **JWT verification** supports HS256 (shared secret) and ES256/RS256 (Supabase JWKS). Other algorithms are rejected.
- **Erasure:** confirm `erase_user` and the auth-identity deletion work end to end against your Supabase project before relying on them for GDPR/DPDP requests.

---

## 3. Reporting Security Vulnerabilities

If you discover a security vulnerability in Pocketful, please report it immediately:
- **Email**: `divyanshgarg2504@gmail.com`
- **Response SLA**: Initial acknowledgement within 24 hours; remediation within 72 hours for critical financial defects.
- Please do **NOT** file public GitHub issues for security vulnerabilities.

---

## 4. Re-audit Fixes & Decisions

- **Caps of 0.** A `per_action_cap_minor` or `weekly_cap_minor` of 0 blocks every action with `money_out_minor > 0`. `cancel_subscription`, `refund_group`, `reset_learning`, `delete_data`, `change_caps` move no user money and stay allowed. `computeFunMoney` with a guilt-free cap of 0 returns 0 (never "uncapped").
- **Money out.** `send_requests` counts the organizer's own share (`total − friend shares`) if provided; friend reimbursements and refunds count 0.
- **Execute-time enforcement.** Caps are re-checked at execution against the user's *current* caps, atomically with the `approved|failed → executing` transition (`begin_execution()` under `pg_advisory_xact_lock`; per-user critical section in the local driver). `executing` approvals count toward the weekly total.
- **Retry** requires a fresh step-up (proof + bound nonce), a full Guardian re-evaluation, ≤3 attempts, ≤24h after `decided_at`.
- **Erasure.** `erase_user()` sets `pocketful.erasure` (honoured only for non-client roles), anonymises `audit_log` (never deletes it), deletes webhook payloads that reference the user's groups/payments (payer PII), deletes lease rows naming the user, and writes an `erased_users` tombstone. A still-valid JWT for a tombstoned user gets `401 ACCOUNT_ERASED`. `erased:true` is returned only after both the DB erase and Supabase auth-identity delete succeed.
- **Errors.** Unknown errors → `500 "Something went wrong."`; `UpstreamError` → generic `502`. Details are logged truncated (500 chars) and token-redacted. Stored approval errors are safe summaries.
