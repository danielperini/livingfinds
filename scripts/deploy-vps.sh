#!/usr/bin/env bash
set -Eeuo pipefail
VPS_PATH="$(printf '%s' "$VPS_PATH_B64" | base64 -d)"
case "$RELEASE_SHA" in (""|*[!0-9a-f]*) echo 'SHA de release inválido' >&2; exit 2;; esac
export LIVINGFINDS_RELEASE_SHA="$RELEASE_SHA"
test -d "$VPS_PATH"
test "$(realpath -- "$VPS_PATH")" != /
cd "$VPS_PATH"

compose_file="$VPS_PATH/server/docker-compose.yml"
stage="$VPS_PATH/.deploy/releases/$RELEASE_SHA"
rollback="$VPS_PATH/.deploy/rollback-$RELEASE_SHA"
backups="$VPS_PATH/.deploy/backups"
mkdir -p "$stage" "$backups" "$VPS_PATH/.deploy"
chmod 700 "$VPS_PATH/.deploy" "$backups"
tar xzf /tmp/deploy.tar.gz -C "$stage"
test -f "$stage/dist/index.html"
test -f "$stage/server/migrations/20261015_optimization_decision_idempotency_preflight.sql"
test -f "$stage/server/migrations/20261015_optimization_decision_idempotency_unique.sql"
test -s "$stage/server/.scheduler-drain-locks.sql"

previous_scheduler="$(docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" exec -T app sh -lc 'printf %s "${ENABLE_SCHEDULER:-true}"')"
case "$previous_scheduler" in true|false) ;; *) echo 'Estado anterior do scheduler não pôde ser confirmado.' >&2; exit 3;; esac
previous_motor_worker="$(docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" exec -T app sh -lc 'printf %s "${ENABLE_MOTOR_RUN_WORKER:-true}"')"
case "$previous_motor_worker" in true|false) ;; *) echo 'Estado anterior do worker não pôde ser confirmado.' >&2; exit 3;; esac
previous_release="$(docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" exec -T app sh -lc 'printf %s "${LIVINGFINDS_RELEASE_SHA:-unknown}"')"
# A previous interrupted deployment may have already paused the old container.
# Keep the pre-maintenance state across retries instead of making that pause permanent.
automation_state_file="$VPS_PATH/.deploy/automation-before-maintenance"
if [ -f "$automation_state_file" ]; then
  read -r previous_scheduler previous_motor_worker previous_release < "$automation_state_file"
else
  printf '%s %s %s\n' "$previous_scheduler" "$previous_motor_worker" "$previous_release" > "$automation_state_file"
  chmod 600 "$automation_state_file"
fi
case "$previous_scheduler/$previous_motor_worker" in true/true|true/false|false/true|false/false) ;; *) echo 'Invalid saved automation state' >&2; exit 3;; esac
paused=0
release_applied=0
restored=0
drain_lock_pid=""
drain_lock_output=""
release_scheduler_drain_locks() {
  if [ -n "$drain_lock_pid" ]; then
    kill "$drain_lock_pid" 2>/dev/null || true
    wait "$drain_lock_pid" 2>/dev/null || true
    drain_lock_pid=""
  fi
  if [ -n "$drain_lock_output" ]; then
    rm -f "$drain_lock_output"
    drain_lock_output=""
  fi
}
restore_automation() {
  if [ "$paused" = 1 ] && [ "$restored" = 0 ]; then
    set +e
    if [ "$release_applied" = 1 ] && [ -d "$rollback/base44" ]; then
      echo '--- falha após troca de código; revertendo pacote para a versão anterior ---' >&2
      rm -rf "$VPS_PATH/base44" "$VPS_PATH/dist" "$VPS_PATH/server/src"
      cp -a "$rollback/base44" "$VPS_PATH/"
      cp -a "$rollback/dist" "$VPS_PATH/"
      cp -a "$rollback/server/src" "$VPS_PATH/server/"
      cp -a "$rollback/server/deno.json" "$rollback/server/Dockerfile" "$rollback/server/docker-compose.yml" "$VPS_PATH/server/"
      restore_compose="$VPS_PATH/server/docker-compose.yml"
      LIVINGFINDS_RELEASE_SHA="$previous_release" ENABLE_SCHEDULER="$previous_scheduler" ENABLE_MOTOR_RUN_WORKER="$previous_motor_worker" \
        docker compose -f "$restore_compose" --project-directory "$VPS_PATH/server" up -d --build app >/dev/null 2>&1
    else
      restore_compose="$VPS_PATH/server/docker-compose.yml"
      [ -f "$restore_compose" ] || restore_compose="$VPS_PATH/server/docker-compose.deploy.yml"
      LIVINGFINDS_RELEASE_SHA="$previous_release" ENABLE_SCHEDULER="$previous_scheduler" ENABLE_MOTOR_RUN_WORKER="$previous_motor_worker" \
        docker compose -f "$restore_compose" --project-directory "$VPS_PATH/server" up -d app >/dev/null 2>&1
    fi
    if [ "$release_applied" = 1 ]; then
      for attempt in $(seq 1 30); do
        if curl --max-time 20 -sf http://127.0.0.1:8000/health >/dev/null; then break; fi
        sleep 2
      done
    fi
    restored=1
    set -e
  fi
  release_scheduler_drain_locks
}
trap restore_automation EXIT

echo '--- bloqueando novas entradas do scheduler e aguardando a drenagem ---'
drain_lock_output="$VPS_PATH/.deploy/scheduler-drain-$RELEASE_SHA.log"
drain_lock_compose="$compose_file"
if ! docker compose -f "$drain_lock_compose" --project-directory "$VPS_PATH/server" ps --services --status running | grep -qx 'db'; then
  drain_lock_compose="$VPS_PATH/server/docker-compose.deploy.yml"
  cp "$stage/server/docker-compose.yml" "$drain_lock_compose"
  chmod 600 "$drain_lock_compose"
fi
docker compose -f "$drain_lock_compose" --project-directory "$VPS_PATH/server" exec -T db \
  psql -v ON_ERROR_STOP=1 -U livingfinds -d livingfinds \
  < "$stage/server/.scheduler-drain-locks.sql" > "$drain_lock_output" 2>&1 &
drain_lock_pid=$!
locks_acquired=0
for attempt in $(seq 1 60); do
  if grep -q 'SCHEDULER_DRAIN_LOCKS_ACQUIRED' "$drain_lock_output" 2>/dev/null; then
    locks_acquired=1
    break
  fi
  if ! kill -0 "$drain_lock_pid" 2>/dev/null; then
    cat "$drain_lock_output" >&2 || true
    echo 'Não foi possível adquirir os locks distribuídos; deploy cancelado sem reiniciar o app.' >&2
    exit 4
  fi
  sleep 10
done
if [ "$locks_acquired" != 1 ]; then
  echo 'Scheduler não drenou em 10 minutos; deploy cancelado sem reiniciar o app.' >&2
  exit 4
fi
echo 'SCHEDULER_DRAIN=locks_acquired'

# The health counter is process-local and can be stale. Confirm durable work directly.
drained=0
for attempt in $(seq 1 60); do
  active_runs="$(docker compose -f "$drain_lock_compose" --project-directory "$VPS_PATH/server" exec -T db psql -U livingfinds -d livingfinds -Atc \
    "SELECT count(*) FROM motor_execution_runs WHERE status='running'")"
  active_claims="$(docker compose -f "$drain_lock_compose" --project-directory "$VPS_PATH/server" exec -T db psql -U livingfinds -d livingfinds -Atc \
    "SELECT count(*) FROM motor_decision_execution_claims WHERE status='authorized' AND lease_expires_at > now()")"
  case "$active_runs/$active_claims" in (*[!0-9/]*) echo 'Estado persistente de execuções não pôde ser validado.' >&2; exit 4;; esac
  echo "DRAIN_WAIT=durable_work|attempt=$attempt|runs=$active_runs|authorized_claims=$active_claims"
  if [ "$active_runs" = 0 ] && [ "$active_claims" = 0 ]; then drained=1; break; fi
  sleep 10
done
if [ "$drained" != 1 ]; then echo 'Tarefas persistentes ou autorizações ainda ativas; deploy cancelado sem reiniciar o app.' >&2; exit 4; fi
extra_engine_processes="$(docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" exec -T app sh -lc '
  n=0
  for f in /proc/[0-9]*/cmdline; do
    [ -r "$f" ] || continue
    # Do not count this inspection shell merely because its command contains the patterns.
    [ "$(cat "${f%cmdline}comm" 2>/dev/null)" = deno ] || continue
    c=$(tr "\\000" " " < "$f" 2>/dev/null || true)
    case "$c" in *deno*eval*runUnifiedDecisionEngine*|*deno*eval*executeApprovedDecisionQueue*|*deno*eval*confirmExecutedDecisions*) n=$((n+1));; esac
  done
  printf %s "$n"
')"
if [ "$extra_engine_processes" != 0 ]; then echo 'Motor ad hoc ainda ativo no VPS; implantação suspensa para não interromper uma ação incerta.' >&2; exit 5; fi

cp "$stage/server/docker-compose.yml" "$VPS_PATH/server/docker-compose.deploy.yml"
chmod 600 "$VPS_PATH/server/docker-compose.deploy.yml"
compose_candidate="$VPS_PATH/server/docker-compose.deploy.yml"
pause_config="$(ENABLE_SCHEDULER=false ENABLE_MOTOR_RUN_WORKER=false docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" config)"
printf '%s\n' "$pause_config" | grep -Eq 'ENABLE_SCHEDULER: "?false"?'
printf '%s\n' "$pause_config" | grep -Eq 'ENABLE_MOTOR_RUN_WORKER: "?false"?'
unset pause_config
paused=1
ENABLE_SCHEDULER=false ENABLE_MOTOR_RUN_WORKER=false \
  docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" up -d app
echo '--- verificando pausa de scheduler e worker ---'
for attempt in $(seq 1 30); do
  if curl --max-time 20 -sf http://127.0.0.1:8000/health > /dev/null; then break; fi
  sleep 2
done
docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T app deno eval '
  const response = await fetch("http://127.0.0.1:8000/health");
  const health = await response.json();
  // The previous release may predate worker health. Also check its actual environment.
  const pausedEnvironment = Deno.env.get("ENABLE_SCHEDULER") === "false" && Deno.env.get("ENABLE_MOTOR_RUN_WORKER") === "false";
  if (!response.ok || !pausedEnvironment || health.scheduler?.enabled !== false || (health.motor_worker !== undefined && health.motor_worker?.enabled !== false)) Deno.exit(1);
  console.log("AUTOMATION_PAUSE=confirmed");
'

echo '--- backup verificável do PostgreSQL ---'
backup_file="$backups/livingfinds-$RELEASE_SHA.dump"
# Only decision rows are touched by this migration. Preserve those rows and the
# full schema; do not copy gigabytes of unrelated immutable snapshots each deploy.
backup_tables=()
for table in optimization_decision optimization_decision_idempotency_archive; do
  exists="$(docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db psql -U livingfinds -d livingfinds -Atc "SELECT to_regclass('public.$table') IS NOT NULL")"
  if [ "$exists" = t ]; then backup_tables+=(-t "$table"); fi
done
if [ "${#backup_tables[@]}" -gt 0 ]; then
  docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db pg_dump -U livingfinds -d livingfinds -Fc "${backup_tables[@]}" > "$backup_file"
else
  docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db pg_dump -U livingfinds -d livingfinds -Fc --schema-only > "$backup_file"
fi
docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db pg_dump -U livingfinds -d livingfinds --schema-only > "$backup_file.schema.sql"
chmod 600 "$backup_file.schema.sql"
test -s "$backup_file"
docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db pg_restore --list < "$backup_file" > /dev/null
sha256sum "$backup_file" > "$backup_file.sha256"
chmod 600 "$backup_file" "$backup_file.sha256"
echo "DATABASE_BACKUP=verified|scope=decision_tables_and_full_schema|sha256=$(cut -d' ' -f1 "$backup_file.sha256")"

echo '--- preflight: arquivar snapshots duplicados sem remover decisões ---'
report_file="$backups/idempotency-preflight-$RELEASE_SHA.txt"
docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db psql -v ON_ERROR_STOP=1 -U livingfinds -d livingfinds -f - \
  < "$stage/server/migrations/20261015_optimization_decision_idempotency_preflight.sql" > "$report_file"
chmod 600 "$report_file"
duplicate_groups="$(docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db psql -v ON_ERROR_STOP=1 -U livingfinds -d livingfinds -Atc "SELECT (SELECT count(*) FROM (SELECT data->>'amazon_account_id',data->>'idempotency_key' FROM optimization_decision WHERE coalesce(data->>'amazon_account_id','')<>'' AND coalesce(data->>'idempotency_key','')<>'' GROUP BY 1,2 HAVING count(*)>1) d)::text || '|' || (SELECT count(*) FROM (SELECT data->>'amazon_account_id',data->>'logical_key' FROM optimization_decision WHERE coalesce(data->>'amazon_account_id','')<>'' AND coalesce(data->>'logical_key','')<>'' GROUP BY 1,2 HAVING count(*)>1) l)::text")"
if [ "$duplicate_groups" != '0|0' ]; then
  echo "MIGRATION_BLOCKED=duplicate_decisions|groups=$duplicate_groups|snapshots=$report_file"
  exit 6
fi
echo '--- aplicando restrições únicas aditivas ---'
docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db psql -v ON_ERROR_STOP=1 -U livingfinds -d livingfinds -f - \
  < "$stage/server/migrations/20261015_optimization_decision_idempotency_unique.sql"

echo '--- verificando índices das consultas de snapshots ---'
docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db psql -v ON_ERROR_STOP=1 -U livingfinds -d livingfinds -f - \
  < "$stage/server/migrations/20261015_repricing_snapshot_lookup_indexes.sql"
lookup_indexes="$(docker compose -f "$compose_candidate" --project-directory "$VPS_PATH/server" exec -T db psql -U livingfinds -d livingfinds -Atc "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indisvalid AND c.relname IN ('repricing_snapshot_account_captured','repricing_snapshot_account_window_created','repricing_snapshot_account_created','repricing_snapshot_account_run_created','repricing_snapshot_account_captured_range')")"
if [ "$lookup_indexes" != 5 ]; then echo 'SNAPSHOT_INDEX_VERIFY=failed' >&2; exit 8; fi

echo '--- preservando código anterior para reversão compatível ---'
mkdir -p "$rollback/server"
cp -a base44 dist "$rollback/"
cp -a server/src server/deno.json server/Dockerfile server/docker-compose.yml "$rollback/server/"
chmod -R go-rwx "$rollback"

echo '--- instalando a release e verificando backend ---'
release_applied=1
rm -rf base44 dist server/src
tar xzf /tmp/deploy.tar.gz -C "$VPS_PATH"
rm -f server/docker-compose.deploy.yml .dockerignore
ENABLE_SCHEDULER=false ENABLE_MOTOR_RUN_WORKER=false \
  docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" up -d --build app
ready=0
for attempt in $(seq 1 30); do
  if curl --max-time 20 -sf http://127.0.0.1:8000/health >/dev/null; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != 1 ]; then docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" logs --tail=120 app; exit 7; fi
docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" exec -T app deno eval '
  const response = await fetch("http://127.0.0.1:8000/health");
  const health = await response.json();
  if (!response.ok || !health.db || health.scheduler?.enabled !== false || health.motor_worker?.enabled !== false) Deno.exit(1);
  console.log("RELEASE_HEALTH=ok|functions=" + health.functions + "|scheduler=paused|motor_worker=paused");
'
functions_json="$(curl --max-time 20 -fsS http://127.0.0.1:8000/functions)"
for required in runUnifiedDecisionEngine executeApprovedDecisionQueue startMotorExecution getMotorExecutionRun listMotorExecutions createOptimizationDecisionIdempotent; do
  printf '%s' "$functions_json" | grep -q "$required"
done
index_count="$(docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" exec -T db psql -U livingfinds -d livingfinds -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ('optimization_decision_idempotency_unique','optimization_decision_logical_key_unique')")"
if [ "$index_count" != 2 ]; then echo 'MIGRATION_VERIFY=failed' >&2; exit 8; fi

echo '--- restaurando scheduler e ativando worker durável ---'
ENABLE_SCHEDULER="$previous_scheduler" ENABLE_MOTOR_RUN_WORKER="$previous_motor_worker" \
  docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" up -d app
for attempt in $(seq 1 30); do
  if curl --max-time 20 -sf http://127.0.0.1:8000/health >/dev/null; then break; fi
  sleep 2
done
docker compose -f "$compose_file" --project-directory "$VPS_PATH/server" exec -T app deno eval '
  const response = await fetch("http://127.0.0.1:8000/health");
  const health = await response.json();
  if (!response.ok || !health.db || health.scheduler?.enabled !== (Deno.env.get("ENABLE_SCHEDULER") === "true") || health.motor_worker?.enabled !== (Deno.env.get("ENABLE_MOTOR_RUN_WORKER") === "true") || health.release_sha !== Deno.env.get("LIVINGFINDS_RELEASE_SHA")) Deno.exit(1);
  console.log("AUTOMATION_RESTORED=confirmed|scheduler=" + health.scheduler.enabled + "|motor_worker=" + health.motor_worker.enabled);
'
restored=1
paused=0
release_scheduler_drain_locks
trap - EXIT
rm -f "$automation_state_file"
echo "DEPLOY_VERIFIED_SHA=$RELEASE_SHA"
echo 'POST_DEPLOY_AMAZON_MUTATIONS=none'
