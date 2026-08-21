#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/opt/livingfinds}"
SERVER_DIR="${ROOT}/server"
BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"

cd "$SERVER_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TOKEN="${API_TOKEN:-${BACKEND_API_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "ERRO: API_TOKEN/BACKEND_API_TOKEN não configurado em server/.env" >&2
  exit 2
fi

call_fn() {
  local name="$1"
  local payload="$2"
  echo
  echo "=== ${name} ==="
  curl -fsS --max-time 180 \
    -X POST "${BASE_URL}/functions/${name}" \
    -H "authorization: Bearer ${TOKEN}" \
    -H 'content-type: application/json' \
    -d "$payload"
  echo
}

echo "============================================================"
echo " LIVING FINDS — VERSÃO VENDAS — EXECUÇÃO IMEDIATA"
echo " $(date -Is)"
echo "============================================================"

curl -fsS --max-time 15 "${BASE_URL}/health" >/dev/null || {
  echo "ERRO: backend não responde em ${BASE_URL}/health" >&2
  exit 3
}

# 1) Atualizar evidência operacional antes de decidir.
call_fn syncAdsCampaignStatesV2 '{"_service_role":true,"trigger_type":"sales_engine_manual_now"}'
call_fn syncAmazonOfferAvailability '{"_service_role":true,"trigger_type":"sales_engine_manual_now"}'
call_fn syncAmazonIntradayCampaignMetrics '{"_service_role":true,"action":"auto","trigger_type":"sales_engine_manual_now"}'

# 2) Supervisor GPT: revisa risco, bloqueios e oportunidades. A saída continua
# subordinada ao ciclo determinístico/árbitro; hard guardrails nunca são bypassados.
call_fn runCanonicalWeeklyDecisionReview '{"_service_role":true,"trigger_type":"sales_engine_intraday_gpt_supervisor","sales_engine_version":"vendas-v1","growth_mode":true}' || true

# 3) Ciclo canônico único -> executor -> confirmação Amazon.
call_fn runCanonicalDecisionCycle '{"_service_role":true,"dry_run":false,"skip_sync":true,"trigger_type":"sales_engine_manual_now","sales_engine_version":"vendas-v1","growth_mode":true,"sales_recovery_mode":true}'
call_fn executeApprovedDecisionQueue '{"_service_role":true,"max_decisions":50,"trigger_type":"sales_engine_manual_now"}'
call_fn confirmExecutedDecisions '{"_service_role":true,"trigger_type":"sales_engine_manual_now"}'

# 4) Reconciliar estado final e auditar o E2E.
call_fn syncAdsCampaignStatesV2 '{"_service_role":true,"trigger_type":"sales_engine_post_execution"}'
call_fn syncAmazonIntradayCampaignMetrics '{"_service_role":true,"action":"auto","trigger_type":"sales_engine_post_execution"}'
call_fn auditAdsAutomationE2E '{"_service_role":true,"trigger_type":"sales_engine_post_execution"}'

echo
echo "Concluído. Considere efetiva somente ação confirmada pela Amazon Ads API."
