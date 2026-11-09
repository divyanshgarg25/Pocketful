#!/usr/bin/env bash
# Prepares a Postgres database for the real-DB suite and starts PostgREST + proxy.
# Required env: TEST_DB_ADMIN_URL (superuser URL to an existing, EMPTY database)
# Optional: POSTGREST_BIN (default: postgrest on PATH), PGRST_JWT_SECRET
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${TEST_DB_ADMIN_URL:?set TEST_DB_ADMIN_URL}"
export PGRST_JWT_SECRET="${PGRST_JWT_SECRET:-test-jwt-secret-test-jwt-secret-1234567890}"
PSQL=(psql "$TEST_DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q)

echo "[db-setup] bootstrap roles/auth schema"
"${PSQL[@]}" -f scripts/db/bootstrap.sql

for f in $(ls supabase/migrations/*.sql | sort); do
  echo "[db-setup] applying $f"
  "${PSQL[@]}" -f "$f"
done

# Migrations we own (005+) must be idempotent: re-apply each and fail on any error.
# (001-004 are frozen and not re-runnable; they are never edited.)
for f in $(ls supabase/migrations/*.sql | sort); do
  n=$(basename "$f" | cut -c1-3)
  if [ "$((10#$n))" -ge 5 ]; then echo "[db-setup] idempotency re-apply $f"; "${PSQL[@]}" -f "$f"; fi
done

PGRST_BIN="${POSTGREST_BIN:-postgrest}"
# authenticator URL: same host/db, different credentials
AUTH_URL=$(node -e 'const u=new URL(process.argv[1]);u.username="authenticator";u.password="authenticator";console.log(u.toString())' "$TEST_DB_ADMIN_URL")
export PGRST_DB_URI="$AUTH_URL" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
       PGRST_SERVER_PORT="${PGRST_PORT:-3000}" PGRST_SERVER_HOST=127.0.0.1
"$PGRST_BIN" >/tmp/pgrst.log 2>&1 &
echo $! > /tmp/pgrst.pid
node scripts/db/proxy.mjs >/tmp/pgrst-proxy.log 2>&1 &
echo $! > /tmp/pgrst-proxy.pid
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PROXY_PORT:-54321}/rest/v1/" -H "apikey: x" >/dev/null 2>&1 || \
     curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PGRST_PORT:-3000}/" | grep -qE '^(200|401)$'; then
    echo "[db-setup] PostgREST ready"; exit 0
  fi
  sleep 0.5
done
echo "[db-setup] PostgREST failed to start"; cat /tmp/pgrst.log; exit 1
