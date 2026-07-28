#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"
STATE_FILE="$DEPLOY_DIR/.release.env"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
RELEASE_ID="${1:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)}"
IMAGE="livingfinds:$RELEASE_ID"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "Copie .release.env.example para .release.env antes do primeiro deploy." >&2
  exit 1
fi
if [[ ! -f "$ROOT_DIR/server/.env" ]]; then
  echo "Crie server/.env com os segredos de produção." >&2
  exit 1
fi

set -a
source "$STATE_FILE"
source "$ROOT_DIR/server/.env"
set +a

if [[ "$ACTIVE_COLOR" == "blue" ]]; then
  TARGET_COLOR="green"
else
  TARGET_COLOR="blue"
fi
TARGET_SERVICE="app_$TARGET_COLOR"

set_state() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$STATE_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$STATE_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$STATE_FILE"
  fi
}

compose() {
  docker compose --env-file "$STATE_FILE" -f "$COMPOSE_FILE" "$@"
}

mkdir -p "$BACKUP_DIR"
echo "[deploy] construindo $IMAGE"
docker build --build-arg "VITE_BASE44_APP_ID=${VITE_BASE44_APP_ID:-selfhosted}" \
  -f "$ROOT_DIR/server/Dockerfile" -t "$IMAGE" "$ROOT_DIR"

set_state "${TARGET_COLOR^^}_IMAGE" "$IMAGE"
set_state "${TARGET_COLOR^^}_RELEASE" "$RELEASE_ID"

compose up -d db
echo "[deploy] backup obrigatório antes das migrações"
compose exec -T db pg_dump -U livingfinds -d livingfinds -Fc \
  > "$BACKUP_DIR/pre-${RELEASE_ID}.dump"

echo "[deploy] preflight e migrações aditivas"
compose run --rm --no-deps "$TARGET_SERVICE" deno task preflight
compose run --rm --no-deps "$TARGET_SERVICE" deno task migrate

echo "[deploy] iniciando candidato $TARGET_COLOR"
compose up -d --no-deps "$TARGET_SERVICE"
for _ in $(seq 1 30); do
  if compose exec -T "$TARGET_SERVICE" \
    deno eval "const r=await fetch('http://127.0.0.1:8000/health');Deno.exit(r.ok?0:1)" \
    >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 2
done
if [[ "${HEALTHY:-0}" != "1" ]]; then
  echo "[deploy] candidato não ficou saudável; produção não foi alterada." >&2
  compose logs --tail=150 "$TARGET_SERVICE"
  exit 1
fi

echo "[deploy] verificando que nenhuma função da versão ativa foi removida"
compose exec -T "$TARGET_SERVICE" deno eval "
  const current = await (await fetch('http://app_${ACTIVE_COLOR}:8000/functions')).json();
  const candidate = await (await fetch('http://app_${TARGET_COLOR}:8000/functions')).json();
  const next = new Set(candidate.functions ?? []);
  const removed = (current.functions ?? []).filter((name) => !next.has(name));
  if (removed.length) {
    console.error('Funções removidas:', removed.join(', '));
    Deno.exit(1);
  }
  console.log('Compatibilidade aprovada:', current.functions.length, 'funções preservadas');
"

cp "$DEPLOY_DIR/nginx/active-upstream.conf" "$DEPLOY_DIR/nginx/active-upstream.conf.previous"
printf 'upstream livingfinds_active {\n  server app_%s:8000;\n  keepalive 32;\n}\n' \
  "$TARGET_COLOR" > "$DEPLOY_DIR/nginx/active-upstream.conf"

compose up -d nginx
if ! compose exec -T nginx nginx -t; then
  mv "$DEPLOY_DIR/nginx/active-upstream.conf.previous" \
    "$DEPLOY_DIR/nginx/active-upstream.conf"
  compose exec -T nginx nginx -s reload
  exit 1
fi
compose exec -T nginx nginx -s reload

set_state ACTIVE_COLOR "$TARGET_COLOR"
set_state WORKER_IMAGE "$IMAGE"
set_state WORKER_RELEASE "$RELEASE_ID"
compose up -d --no-deps worker

echo "[deploy] release $RELEASE_ID ativa em $TARGET_COLOR"
echo "[deploy] versão anterior preservada em $ACTIVE_COLOR para rollback"
