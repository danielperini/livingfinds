# Economic Budget Balancer

O `runEconomicBudgetBalancer` é o serviço canônico de balanceamento intradiário de Sponsored Products. Ele usa dados persistidos das APIs Amazon Ads/SP-API, calcula participação real no gasto da conta, classifica cada campanha e propõe mudanças pequenas de bid ou orçamento sem pausar campanhas por ausência isolada de venda.

## Fluxo operacional

1. Sincroniza estados e métricas intradiárias, exceto quando o agendamento informa `skip_sync`.
2. Carrega campanhas, grupos, keywords, product targets, produtos, estoque, economia e histórico.
3. Bloqueia aumento quando dados estão desatualizados, estrutura incompleta, produto sem estoque/Buy Box ou economia indisponível.
4. Distribui um orçamento virtual entre descoberta automática, aprendizado manual, vencedores e campanhas protegidas.
5. Classifica a campanha e propõe observar, reduzir/aumentar bid ou ampliar orçamento de vencedores.
6. Cria uma `OptimizationDecision` idempotente. Em execução real, usa `executeAutopilotDecisionV2`; a confirmação é feita por leitura posterior da Amazon.

Por padrão, chamadas manuais são `dry_run`. Execução real exige `dry_run: false`, a flag `economic_budget_balancer_enabled` e uma configuração ativa. O agendamento roda a cada 15 minutos, quatro minutos depois da sincronização intradiária.

## Guardrails principais

- Aumento de bid: no máximo 6% por ciclo e limitado pelo CPC econômico seguro.
- Redução por falta de conversão: gradual, no máximo 12% por ciclo.
- Campanha automática: participação limitada por `max_auto_discovery_share`.
- Campanha concentradora: participação comparada ao alvo e ao teto da conta.
- Campanha vencedora: não sofre redução automática enquanto protegida.
- Primeiras seis horas e janelas de aprendizado: observação antes de intervenção.
- Ausência de venda isolada: nunca gera pausa de campanha; decisões antigas desse tipo também são bloqueadas no executor.
- Idempotência: conta + perfil + campanha + entidade + ação + janela de decisão.
- Cooldown e limites de alterações por ciclo/hora.

## Configuração

Os campos ficam em `AutopilotConfig` e podem ser alterados em Ads Autopilot > Configurações. Os principais são:

- `economic_budget_balancer_enabled`
- `account_daily_budget_limit`
- `max_campaign_spend_share`
- `max_auto_discovery_share`
- `auto_discovery_target_share`
- `manual_learning_target_share`
- `winner_target_share`
- `guarded_target_share`
- `max_spend_without_sale` (zero deriva da verba econômica por pedido)
- `test_tolerance_factor`
- `learning_window_hours`
- `data_freshness_minutes`
- `decision_window_minutes`
- `cooldown_hours`
- `max_changes_per_cycle`
- `max_changes_per_hour`

## Dry run

Na aba **Balanceamento**, use **Simular agora**. A resposta mostra gasto atual, saldo, concentração, campanhas sem impressão/clique, vencedores, economia estimada e cada proposta com valor anterior, valor sugerido, motivo e próxima avaliação. O dry run não cria decisão nem chama uma operação de escrita da Amazon.

Para ativar gradualmente, mantenha a feature flag desligada, valide as simulações e depois ligue `economic_budget_balancer_enabled`. Os wrappers legados delegam ao balanceador ou ao motor unificado para evitar motores paralelos competindo pelo mesmo bid.
