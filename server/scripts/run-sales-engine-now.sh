#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/opt/livingfinds}"
SERVER_DIR="${ROOT}/server"
BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
ENV_FILE="${SERVER_DIR}/.env"

cd "$SERVER_DIR"

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

wait_health() {
  local tries="${1:-40}"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS --max-time 8 "${BASE_URL}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  echo "ERRO: backend não ficou saudável após $((tries*3))s" >&2
  return 1
}

call_fn() {
  local name="$1"
  local payload="$2"
  local attempts="${3:-2}"
  local attempt rc
  echo
  echo "=== ${name} ==="
  for attempt in $(seq 1 "$attempts"); do
    wait_health 40 || true
    set +e
    curl -fsS --max-time 600 \
      -X POST "${BASE_URL}/functions/${name}" \
      -H "authorization: Bearer ${TOKEN}" \
      -H 'content-type: application/json' \
      -d "$payload"
    rc=$?
    set -e
    echo
    if [[ "$rc" -eq 0 ]]; then
      echo "${name}: OK"
      return 0
    fi
    echo "${name}: tentativa ${attempt}/${attempts} falhou (curl=${rc})" >&2
    sleep 5
  done
  echo "${name}: FALHOU após ${attempts} tentativa(s); seguindo para preservar o restante do ciclo." >&2
  return 1
}

echo "================================================================"
echo " LIVING FINDS SALES ENGINE — VENDAS COM RISCO CONTROLADO v1"
echo " REVISÃO TOTAL E EXECUÇÃO IMEDIATA — MODO RESILIENTE"
echo " $(date -Is)"
echo "================================================================"

wait_health 40

COMMON='"_service_role":true,"sales_engine_version":"sales-risk-v1","engine_title":"Living Finds Sales Engine — Vendas com Risco Controlado v1","growth_mode":true,"sales_recovery_mode":true'

failures=0
run_step() {
  local name="$1" payload="$2"
  if ! call_fn "$name" "$payload" 2; then failures=$((failures+1)); fi
}

# Evidência fresca.
run_step syncAdsCampaignStatesV2 "{${COMMON},\"trigger_type\":\"sales_risk_activation_state_sync\"}"
run_step syncAmazonOfferAvailability "{${COMMON},\"trigger_type\":\"sales_risk_activation_offer_sync\"}"
run_step syncAmazonIntradayCampaignMetrics "{${COMMON},\"action\":\"auto\",\"trigger_type\":\"sales_risk_activation_intraday_sync\"}"

# Supervisor GPT. Falha de IA não impede o motor determinístico.
run_step runCanonicalWeeklyDecisionReview "{${COMMON},\"trigger_type\":\"sales_risk_activation_gpt_supervisor\",\"activation_review\":true}"

# Revisão total do portfólio pelo motor canônico.
run_step runCanonicalDecisionCycle "{${COMMON},\"dry_run\":false,\"skip_sync\":true,\"bootstrap\":true,\"force_campaign_lifecycle\":true,\"force_dayparting\":true,\"migrate_daypart_rules\":true,\"full_repricing_evaluation\":false,\"serving_campaign_growth_target_pct\":60,\"max_auto_budget_expansions\":8,\"max_new_exact_per_run\":8,\"max_structure_repairs_per_run\":12,\"max_bid_recoveries_per_run\":12,\"max_economic_evidence_candidates\":1000,\"trigger_type\":\"sales_risk_activation_full_portfolio_review\"}"

# Execução e confirmação Amazon em chamadas separadas.
run_step executeApprovedDecisionQueue "{${COMMON},\"max_decisions\":100,\"trigger_type\":\"sales_risk_activation_executor\"}"
run_step confirmExecutedDecisions "{${COMMON},\"trigger_type\":\"sales_risk_activation_confirmation\"}"

# Revalidação final.
run_step syncAmazonIntradayCampaignMetrics "{${COMMON},\"action\":\"auto\",\"trigger_type\":\"sales_risk_activation_post_execution_sync\"}"
run_step auditAdsAutomationE2E "{${COMMON},\"trigger_type\":\"sales_risk_activation_e2e_audit\"}"

echo
echo "================================================================"
echo " Motor concluído em modo resiliente. Falhas de etapa: ${failures}"
echo " Considere efetiva somente ação confirmada pela Amazon Ads API."
echo "================================================================"

# Retorna sucesso se o backend permaneceu vivo; as falhas individuais já foram logadas.
wait_health 10
