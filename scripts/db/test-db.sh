#!/usr/bin/env bash
# `npm run test:db`: boots a throwaway local Postgres (unless TEST_DB_ADMIN_URL is set), then runs the suite.
set -euo pipefail
cd "$(dirname "$0")/../.."
cleanup() {
  [ -f /tmp/pgrst.pid ] && kill "$(cat /tmp/pgrst.pid)" 2>/dev/null || true
  [ -f /tmp/pgrst-proxy.pid ] && kill "$(cat /tmp/pgrst-proxy.pid)" 2>/dev/null || true
  rm -f /tmp/pgrst.pid /tmp/pgrst-proxy.pid
  if [ -n "${PGDATA_TMP:-}" ]; then
    if [ "$(id -u)" = 0 ]; then su postgres -c "$PGBIN/pg_ctl -D $PGDATA_TMP -m immediate stop" >/dev/null 2>&1 || true
    else "$PGBIN/pg_ctl" -D "$PGDATA_TMP" -m immediate stop >/dev/null 2>&1 || true; fi
    rm -rf "$PGDATA_TMP"
  fi
}
trap cleanup EXIT
if [ -z "${TEST_DB_ADMIN_URL:-}" ]; then
  PGBIN=$(dirname "$(ls /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")
  PGDATA_TMP=$(mktemp -d /tmp/pocketful-pg.XXXXXX)
  PORT=54329
  if [ "$(id -u)" = 0 ]; then
    chown postgres "$PGDATA_TMP"
    RUN=(su postgres -c)
    su postgres -c "$PGBIN/initdb -D $PGDATA_TMP -A trust -U postgres >/dev/null"
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA_TMP -o '-p $PORT -k /tmp' -w -l $PGDATA_TMP/log start >/dev/null"
  else
    "$PGBIN/initdb" -D "$PGDATA_TMP" -A trust -U postgres >/dev/null
    "$PGBIN/pg_ctl" -D "$PGDATA_TMP" -o "-p $PORT -k /tmp" -w -l "$PGDATA_TMP/log" start >/dev/null
  fi
  psql "postgres://postgres@127.0.0.1:$PORT/postgres" -qc "create database pocketful_test"
  export TEST_DB_ADMIN_URL="postgres://postgres@127.0.0.1:$PORT/pocketful_test"
fi
export POSTGREST_BIN="${POSTGREST_BIN:-$(command -v postgrest || echo /opt/pgrst/postgrest)}"
bash scripts/db/setup.sh
export TEST_PGRST_URL="http://127.0.0.1:${PROXY_PORT:-54321}"
export PGRST_JWT_SECRET="${PGRST_JWT_SECRET:-test-jwt-secret-test-jwt-secret-1234567890}"
npm run test:db:run --workspace pocketful-api
