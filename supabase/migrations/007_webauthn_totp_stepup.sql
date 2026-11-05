-- 007: real step-up factors. Idempotent (re-applied by the harness). 001-006 are never edited.
--   * WebAuthn / passkeys (primary factor)
--   * TOTP authenticator app (fallback; secret encrypted by the API, never stored in plaintext)
--   * PIN stays as a fallback. All three share ONE failure counter / lockout (step_up_credentials), so an
--     attacker cannot alternate factors to multiply guesses.
-- Every table is service-role only: RLS enabled with no policies and all grants revoked from client roles.

-- 1. step_up_credentials: PIN becomes optional (a user may have only TOTP), add TOTP columns ----------------
alter table step_up_credentials alter column pin_salt drop not null;
alter table step_up_credentials alter column pin_hash drop not null;
alter table step_up_credentials add column if not exists totp_secret_enc text;
alter table step_up_credentials add column if not exists totp_pending_secret_enc text;
alter table step_up_credentials add column if not exists totp_confirmed_at timestamptz;
-- Highest 30-second TOTP step already accepted: a code can never be replayed.
alter table step_up_credentials add column if not exists totp_last_step bigint not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_step_up_pin_pair' and conrelid = 'step_up_credentials'::regclass) then
    alter table step_up_credentials add constraint chk_step_up_pin_pair
      check ((pin_salt is null) = (pin_hash is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_step_up_totp_confirmed' and conrelid = 'step_up_credentials'::regclass) then
    alter table step_up_credentials add constraint chk_step_up_totp_confirmed
      check ((totp_secret_enc is null) = (totp_confirmed_at is null));
  end if;
end $$;

-- 2. webauthn_credentials --------------------------------------------------------------------------------
create table if not exists webauthn_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  credential_id text not null unique,          -- base64url
  public_key text not null,                    -- base64url COSE key
  counter bigint not null default 0 check (counter >= 0),
  transports text[],
  device_type text check (device_type in ('singleDevice', 'multiDevice')),
  backed_up boolean not null default false,
  label text check (label is null or char_length(label) <= 64),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists idx_webauthn_credentials_user on webauthn_credentials(user_id);
alter table webauthn_credentials enable row level security;
revoke all on webauthn_credentials from public, anon, authenticated;
grant all on webauthn_credentials to service_role;

-- 3. webauthn_challenges: single-use, short-lived, one live challenge per (user, purpose) -----------------
--    purpose 'register' = passkey registration ceremony, 'enroll' = proof before adding/changing a factor.
--    (Approval step-up challenges live on the approval row, bound to its fingerprint.)
create table if not exists webauthn_challenges (
  user_id uuid not null references profiles(id) on delete cascade,
  purpose text not null check (purpose in ('register', 'enroll')),
  challenge text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, purpose)
);
alter table webauthn_challenges enable row level security;
revoke all on webauthn_challenges from public, anon, authenticated;
grant all on webauthn_challenges to service_role;
