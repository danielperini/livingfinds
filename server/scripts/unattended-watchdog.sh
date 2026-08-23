#!/usr/bin/env bash
set -euo pipefail
ROOT="${ROOT:-/opt/livingfinds}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
cd "$ROOT"

read_env(){
  local key="$1"
  python3 - "$ROOT/server/.env" "$key" <<'PY'
import sys
p,key=sys.argv[1],sys.argv[2]
try: lines=open(p,encoding='utf-8').read().splitlines()
except FileNotFoundError: print(''); raise SystemExit
for raw in lines:
    line=raw.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1)
    if k.strip()!=key: continue
    v=v.strip()
    if len(v)>=2 and v[0]==v[-1] and v[0] in "\"'": v=v[1:-1]
    print(v); break
PY
}
TOKEN="${API_TOKEN:-${BACKEND_API_TOKEN:-$(read_env API_TOKEN)}}"

health_ok(){ curl -fsS --max-time 10 "$BASE_URL/health" >/dev/null 2>&1; }
if ! health_ok; then
  echo "[$(date -Is)] backend indisponível; reiniciando stack" >&2
  docker compose -f server/docker-compose.yml up -d >/dev/null
  for _ in $(seq 1 20); do sleep 3; health_ok && break; done
fi
if ! health_ok; then
  echo "[$(date -Is)] ERRO: backend continua indisponível" >&2
  exit 1
fi

if [[ -z "$TOKEN" ]]; then
  echo "[$(date -Is)] ERRO: API_TOKEN ausente" >&2
  exit 2
fi

set +e
RESP=$(curl -sS --max-time 90 -w '\nHTTP_STATUS=%{http_code}' \
  -X POST "$BASE_URL/functions/checkUnattendedAutomationHealth" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"_service_role":true,"trigger_type":"systemd_unattended_watchdog"}')
RC=$?
set -e
printf '%s\n' "$RESP"
if [[ $RC -ne 0 ]]; then exit $RC; fi
STATUS=$(printf '%s\n' "$RESP" | sed -n 's/^HTTP_STATUS=//p' | tail -1)
if [[ "$STATUS" != "200" ]]; then
  echo "[$(date -Is)] automação degradada (HTTP $STATUS); disparando recuperação canônica" >&2
  "$ROOT/server/scripts/run-sales-engine-now.sh" || true
  exit 1
fi
