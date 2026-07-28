#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$DEPLOY_DIR/.release.env"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"

set -a
source "$STATE_FILE"
source "$DEPLOY_DIR/../.env"
set +a

if [[ "$ACTIVE_COLOR" == "blue" ]]; then
  TARGET_COLOR="green"
  TARGET_IMAGE="$GREEN_IMAGE"
  TARGET_RELEASE="$GREEN_RELEASE"
else
  TARGET_COLOR="blue"
  TARGET_IMAGE="$BLUE_IMAGE"
  TARGET_RELEASE="$BLUE_RELEASE"
fi

compose() {
  docker compose --env-file "$STATE_FILE" -f "$COMPOSE_FILE" "$@"
}
set_state() {
  sed -i "s|^$1=.*|$1=$2|" "$STATE_FILE"
}

compose up -d --no-deps "app_$TARGET_COLOR"
compose exec -T "app_$TARGET_COLOR" \
  deno eval "const r=await fetch('http://127.0.0.1:8000/health');Deno.exit(r.ok?0:1)"

printf 'upstream livingfinds_active {\n  server app_%s:8000;\n  keepalive 32;\n}\n' \
  "$TARGET_COLOR" > "$DEPLOY_DIR/nginx/active-upstream.conf"
compose exec -T nginx nginx -t
compose exec -T nginx nginx -s reload

set_state ACTIVE_COLOR "$TARGET_COLOR"
set_state WORKER_IMAGE "$TARGET_IMAGE"
set_state WORKER_RELEASE "$TARGET_RELEASE"
compose up -d --no-deps worker

echo "[rollback] tráfego e scheduler voltaram para $TARGET_COLOR ($TARGET_RELEASE)"
echo "[rollback] banco não foi restaurado: migrações de release devem ser retrocompatíveis."
