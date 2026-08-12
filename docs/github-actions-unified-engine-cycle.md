# Ciclo do motor unificado via GitHub Actions

O motor está na fase `full` (autonomia total). Este ciclo deve ser agendado no repositório
onde o backend externo é implantado. Crie manualmente o arquivo
`.github/workflows/unified-engine-cycle.yml` com o conteúdo abaixo — o app Base44 não tem
permissão para gravar arquivos em `.github/workflows/`.

Horários: 06:00 BRT (09:00 UTC) e 20:00 BRT (23:00 UTC).

```yaml
name: Ciclo do motor unificado (fase full)

on:
  schedule:
    - cron: '0 9 * * *'
    - cron: '0 23 * * *'
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
                const token = Deno.env.get("API_TOKEN") || Deno.env.get("ADMIN_PASSWORD") || "";
                const call = async (name, payload) => {
                  const response = await fetch("http://127.0.0.1:8000/functions/" + name, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-api-token": token },
                    body: JSON.stringify(payload),
                  });
                  const data = await response.json().catch(() => ({}));
                  console.log(name.toUpperCase() + "_HTTP=" + response.status + "|OK=" + data.ok + "|DATA=" + JSON.stringify(data).slice(0, 20000));
                  if (!response.ok || data.ok === false) throw new Error(data.error || ("Falha em " + name));
                  return data;
                };

                const common = { _service_role: true, dry_run: false, trigger_type: "github_actions_unified_engine_cycle" };

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

O token da Amazon Ads está com status `revoked`. Enquanto ele não for reconectado em
Configurações, o motor decide e registra as ações, mas **não escreve na Amazon**.