#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/opt/livingfinds}"
SERVER_DIR="${ROOT}/server"
BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
ENV_FILE="${SERVER_DIR}/.env"

cd "$SERVER_DIR"

# Nunca executar/source o .env: ele pode conter nomes com espaços, JSON,
# tokens longos ou valores multilinha que não são sintaxe shell válida.
read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  python3 - "$ENV_FILE" "$key" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); key=sys.argv[2]
for raw in p.read_text(encoding='utf-8', errors='replace').splitlines():
    line=raw.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k,v=line.split('=',1)
    if k.strip() != key:
        continue
    v=v.strip()
    if len(v)>=2 and v[0]==v[-1] and v[0] in "\"'":
        v=v[1:-1]
    print(v, end='')
    break
PY
}

TOKEN="${API_TOKEN:-${BACKEND_API_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then TOKEN="$(read_env_value API_TOKEN)"; fi
if [[ -z "$TOKEN" ]]; then TOKEN="$(read_env_value BACKEND_API_TOKEN)"; fi
if [[ -z "$TOKEN" ]]; then
  echo "ERRO: API_TOKEN/BACKEND_API_TOKEN não configurado em server/.env" >&2
  exit 2
fi

call_fn() {
  local name="$1"
  local payload="$2"
  echo
  echo "=== ${name} ==="
  curl -fsS --max-time 600 \
    -X POST "${BASE_URL}/functions/${name}" \
    -H "authorization: Bearer ${TOKEN}" \
    -H 'content-type: application/json' \
    -d "$payload"
  echo
}

echo "================================================================"
echo " LIVING FINDS SALES ENGINE — VENDAS COM RISCO CONTROLADO v1"
echo " REVISÃO TOTAL E EXECUÇÃO IMEDIATA"
echo " $(date -Is)"
echo "================================================================"

curl -fsS --max-time 15 "${BASE_URL}/health" >/dev/null || {
  echo "ERRO: backend não responde em ${BASE_URL}/health" >&2
  exit 3
}

call_fn runSalesRiskImmediateReview '{"_service_role":true,"trigger_type":"manual_sales_risk_activation","serving_campaign_growth_target_pct":60,"max_auto_budget_expansions":8,"max_new_exact_per_run":8,"max_structure_repairs_per_run":12,"max_bid_recoveries_per_run":12,"max_economic_evidence_candidates":1000,"max_decisions":100}'

echo
echo "Motor acionado: Living Finds Sales Engine — Vendas com Risco Controlado v1"
echo "Todas as campanhas/keywords/targets/bids foram submetidos à revisão total."
echo "Somente mutações economicamente defensáveis são executadas."
echo "Considere efetiva somente ação confirmada pela Amazon Ads API."
