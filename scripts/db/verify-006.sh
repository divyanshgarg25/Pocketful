#!/usr/bin/env bash
# Verifies migration 006 against a REAL Postgres (needs psql + a scratch DB). Usage: PGHOST=.. PGPORT=.. PGUSER=.. scripts/db/verify-006.sh <dbname>
# Expects a Supabase-like auth schema (auth.users, auth.uid(), auth.role()) and roles anon/authenticated/service_role,
# and migrations 001-004 already applied. Exits non-zero on any failed assertion.
set -euo pipefail
DB="${1:?usage: verify-006.sh <dbname>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/../../supabase/migrations/006_execution_integrity_stepup.sql"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/../../supabase/migrations/006_execution_integrity_stepup.sql"   # idempotent re-apply
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$HERE/verify-006.sql"
echo "verify-006: OK"
