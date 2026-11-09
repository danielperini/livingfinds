# Ciclo do motor unificado via GitHub Actions

O motor está na fase `full` (autonomia total). O ciclo está versionado em
`.github/workflows/unified-engine-cycle.yml` no mesmo repositório em que o backend externo
é implantado.

Cadência: a cada 3 horas. O cron do GitHub Actions usa UTC; no horário de
Brasília, os ciclos ocorrem às 00h, 03h, 06h, 09h, 12h, 15h, 18h e 21h.

Além do ciclo operacional, existe uma execução diária separada às 13:00 UTC
(10:00 BRT): `runDailyAiAdsAnalysis`. Ela lê os relatórios já sincronizados,
monta um conjunto compacto de evidências, consulta o modelo configurado em
`OPENAI_MODEL` (padrão econômico `gpt-4o-mini`) e grava recomendações na fila
de decisões. A rotina é idempotente por conta/data e não dispara uma segunda
análise no mesmo dia.

Guardrails da análise diária:

- reduções de bid têm piso, teto e passo máximo;
- aumentos de bid exigem conversão, ACoS compatível e confiança mínima de 80%;
- redistribuição de orçamento não aumenta o teto diário da conta;
- termo irrelevante com gasto e zero venda pode virar negativo exato;
- criação de campanha manual exige conversão atribuída ao mesmo SKU;
- pausa de campanha fica em revisão manual e só é válida como último recurso;
- decisões de baixo risco são aprovadas para `executeApprovedDecisionQueue`,
  enquanto criação, expansão de budget e pausa ficam pendentes de revisão.

```yaml
name: Ciclo do motor unificado (fase full)

on:
  schedule:
    - cron: '0 */3 * * *'
  workflow_dispatch:

concurrency:
  group: unified-engine-cycle
  cancel-in-progress: false

jobs:
  cycle:
    runs-on: ubuntu-latest
    steps:
      - name: Preparar SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          test -n "${{ secrets.VPS_HOST }}"

      - name: Executar ciclo completo do motor na VPS
        env:
          SSHOPTS: -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
          TARGET: ${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}
          VPS_PATH: ${{ secrets.VPS_PATH }}
        run: |
          set -euo pipefail
          success=0
          for attempt in 1 2 3 4 5; do
            echo "Tentativa SSH ${attempt}/5"
            if ssh $SSHOPTS "$TARGET" "bash -s" <<EOF
              set -euo pipefail
              cd "$VPS_PATH"

              ready=0
              for health_attempt in \$(seq 1 30); do
                if curl -sf http://127.0.0.1:8000/health >/dev/null; then
                  ready=1
                  break
                fi
                sleep 2
              done
              if [ "\$ready" -ne 1 ]; then
                echo "Backend não ficou saudável para o ciclo do motor"
                exit 1
              fi

              docker compose -f server/docker-compose.yml exec -T app deno eval '
                const TOKEN_REVOKED = "ADS_TOKEN_REVOKED_REAUTH_REQUIRED";
                const token = Deno.env.get("API_TOKEN") || Deno.env.get("ADMIN_PASSWORD") || "";
                const call = async (name, payload) => {
                  const response = await fetch("http://127.0.0.1:8000/functions/" + name, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-api-token": token },
                    body: JSON.stringify(payload),
                  });
                  const data = await response.json().catch(() => ({}));
                  console.log(name.toUpperCase() + "_HTTP=" + response.status + "|OK=" + data.ok + "|DATA=" + JSON.stringify(data).slice(0, 20000));
                  const operationalError = String(data.error_message || data.error || "");
                  if (operationalError === TOKEN_REVOKED) {
                    console.error(TOKEN_REVOKED + ": ciclo abortado antes das demais funções.");
                    throw new Error(TOKEN_REVOKED);
                  }
                  if (!response.ok || data.ok === false) throw new Error(operationalError || ("Falha em " + name));
                  return data;
                };

                const common = { _service_role: true, dry_run: false, trigger_type: "github_actions_unified_engine_cycle" };

                await call("refreshAmazonAdsTokenDailyOrHourly", {
                  _service_role: true,
                  force: true,
                  precheck_operation: "unified_engine_cycle",
                  trigger_type: "github_actions_unified_engine_token_precheck",
                });

                await call("classifyMarketplaceCampaignJourneys", common);
                await call("reactivatePausedWithStock", common);
                await call("runUnifiedDecisionEngine", { ...common, force_campaign_lifecycle: true });
                await call("runEconomicBudgetBalancer", common);
                const orchestrator = await call("runDailyMasterOrchestrator", common);

                const executor = await call("executeApprovedDecisionQueue", {
                  _service_role: true,
                  max_decisions: 25,
                  trigger_type: "github_actions_unified_engine_executor",
                });

                await new Promise((resolve) => setTimeout(resolve, 5000));
                const confirmation = await call("confirmExecutedDecisions", {
                  _service_role: true,
                  trigger_type: "github_actions_unified_engine_confirmation",
                });

                console.log("UNIFIED_ENGINE_CYCLE_SUMMARY=" + JSON.stringify({
                  orchestrator_ok: orchestrator?.ok ?? null,
                  executor_executed: executor?.executed ?? null,
                  confirmation,
                }).slice(0, 20000));
              ' </dev/null
          EOF
            then
              success=1
              break
            fi
            sleep $((attempt * 15))
          done

          if [ "$success" -ne 1 ]; then
            echo "Falha após 5 tentativas de conexão/execução na VPS"
            exit 1
          fi
```

## Configuração aplicada na conta

| Parâmetro | Valor |
|---|---|
| `unified_rollout_phase` | `full` |
| `unified_engine_dry_run` | `false` |
| `unified_max_campaign_actions_per_cycle` | `10` |
| `unified_max_price_actions_per_cycle` | `5` |
| `economic_budget_balancer_enabled` | `true` |
| `approval_required` | `false` |

Guardrails mantidos: `max_bid` R$1,80, `daily_budget_limit` R$125,
`unified_max_bid_actions_per_cycle` 5, `unified_max_daily_spend` R$80.

## Pré-requisito crítico

Antes de qualquer função decisória, o workflow força uma tentativa de renovação do token.
Se a Amazon ainda retornar `invalid_grant`, `unauthorized_client`, 401 ou 403, o job encerra
com código diferente de zero e `ADS_TOKEN_REVOKED_REAUTH_REQUIRED`; nenhuma nova decisão é
enfileirada. Depois da reautorização em Configurações, a próxima pré-checagem resolve o alerta
operacional automaticamente e o ciclo volta a prosseguir.

## Análise diária de Ads com IA

Às 10:00 BRT (`0 13 * * *` em UTC), o workflow chama `runDailyAiAdsAnalysis` uma vez por conta.
Antes de analisar, a função atualiza os relatórios do dia; se a atualização falhar, nenhuma decisão
é criada com dados antigos. A análise envia ao GPT apenas um conjunto compacto de evidências e inclui
a distribuição de orçamento das campanhas ativas, participação de cada budget, campanhas sem gasto,
vencedoras e campanhas acima do ACoS máximo.

As propostas respeitam os limites determinísticos: bid mínimo/máximo, variação máxima, teto diário,
confiança mínima de 80%, aumento de budget sem ultrapassar o teto e pausa somente como último recurso.
Reduções de bid e negativas de baixo risco podem ser executadas automaticamente; criação de campanha,
aumento de budget e pausa ficam em revisão manual. Decisões aprovadas de baixo risco são executadas e
depois confirmadas pela Amazon no ciclo seguinte.

Para reduzir CPU e picos de chamadas, a rotina lê campanhas, keywords, termos, métricas e economia
em páginas de até 400 registros, com intervalo de 250 ms entre páginas. As decisões automáticas são
enviadas à Amazon em lotes de até 5, com intervalo de 800 ms, e a confirmação ocorre somente depois
do último lote.

