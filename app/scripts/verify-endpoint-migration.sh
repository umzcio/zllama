#!/usr/bin/env bash
# Proves the Server -> Endpoint migration preserves rows and foreign keys.
# Builds a throwaway database, seeds it, applies migrations, asserts survival.
set -euo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DB="$WORK/test.db"

export DATABASE_URL="file:$DB"

# Apply every migration EXCEPT the rename and the later column drop (which
# depends on the Endpoint table the rename creates), by pointing at a copy of
# the migrations directory with both removed.
cp -r prisma "$WORK/prisma"
rm -rf "$WORK"/prisma/migrations/*_rename_server_to_endpoint
rm -rf "$WORK"/prisma/migrations/*_drop_gpu_agent_url
npx prisma migrate deploy --schema "$WORK/prisma/schema.prisma" >/dev/null

# Seed one Server (with gpuAgentUrl set, exercising the column as it existed
# pre-drop — the column is dropped by a later migration in the chain) and
# one Log that references it.
sqlite3 "$DB" <<'SQL'
INSERT INTO "Server" ("id","name","url","gpuAgentUrl","active","createdAt")
VALUES ('srv_keep','gpu-node-1','http://10.0.0.9:11434','http://10.0.0.9:11435',1,CURRENT_TIMESTAMP);
INSERT INTO "Log" ("id","serverId","model","endpoint","latencyMs","statusCode","createdAt")
VALUES ('log_keep','srv_keep','qwen3:32b','/api/generate',120,200,CURRENT_TIMESTAMP);
SQL

# Now apply the real migrations directory, which includes the rename and the
# gpuAgentUrl column drop.
npx prisma migrate deploy >/dev/null

fail=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label — expected '$expected', got '$actual'"
    fail=1
  fi
}

check "Endpoint table exists" "1" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='Endpoint';")"
check "Server table is gone" "0" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='Server';")"
check "endpoint row survived" "gpu-node-1" \
  "$(sqlite3 "$DB" "SELECT name FROM \"Endpoint\" WHERE id='srv_keep';")"
check "engine defaulted to ollama" "ollama" \
  "$(sqlite3 "$DB" "SELECT engine FROM \"Endpoint\" WHERE id='srv_keep';")"
check "gpuAgentUrl column dropped" "0" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM pragma_table_info('Endpoint') WHERE name='gpuAgentUrl';")"
check "log kept its FK as endpointId" "srv_keep" \
  "$(sqlite3 "$DB" "SELECT endpointId FROM \"Log\" WHERE id='log_keep';")"
check "log row survives scoped to its endpointId FK" "1" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM \"Log\" WHERE endpointId='srv_keep';")"
check "Log_endpointId_createdAt_idx index exists" "1" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='Log_endpointId_createdAt_idx';")"
check "_EndpointToHost join table exists" "1" \
  "$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='_EndpointToHost';")"
check "foreign_key_check reports no violations" "" \
  "$(sqlite3 "$DB" "PRAGMA foreign_key_check;")"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
