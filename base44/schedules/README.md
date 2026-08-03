# Organização dos agendamentos Amazon

Fonte canônica: `amazon-automation-schedule.json` (timezone `America/Sao_Paulo`).

## Ordem diária principal

1. 00:01 — solicitar relatórios do dia fechado.
2. 00:05 — criar o plano diário de pacing.
3. 05:15–05:50 — sincronizar histórico, reconstruir métricas e atualizar Finance Events.
4. 06:00 — recuperação de filas e estados incompletos.
5. 06:40 — auditoria matinal dos relatórios.
6. 07:10 — garantir cobertura AUTO dos produtos ativos, sem repetir o harvest.
7. 07:25 — aplicar a estratégia econômica para produtos de baixo volume.
8. 07:45 — harvest unificado AUTO/MANUAL, Keyword Bank, Campaign Factory e promoções EXACT.
9. 08:00–08:55 — avaliação econômica, relatório, dayparting, estratégia de lance e títulos.
10. 23:45 — reconciliação final dos relatórios.

## Regras de concorrência

- A fila de reparo AUTO roda nos minutos ímpares; o guardrail de lucro permanece nos minutos pares.
- O executor de bids foi deslocado do mesmo minuto do polling de relatórios.
- O pipeline horário do Motor v8 foi deslocado do minuto do executor de bids.
- A reposição de orçamento vencedor ocorre depois do pipeline de métricas e fora do minuto do Stock Guard.
- A auditoria do teto de bid foi deslocada do mesmo minuto da confirmação de decisões.
- O harvest diário não chama uma segunda rotina autônoma de Term Bank/Factory: essas etapas já fazem parte do pipeline unificado.
- Jobs `run_on_startup` entram numa fila com intervalo de 30 segundos após o deploy.

## Repetições intencionais

- `runAutomaticRepricing`: avaliação, processamento da fila e reconciliação são operações diferentes.
- `ensureDailyReportsCurrent`: solicitação do dia fechado e autocorreção de frescor têm objetivos diferentes.
- `syncFinanceEventsFromSpApi`: atualização matinal e reforços intradiários.
- `runIntraDayPacingCycle`: pacing recorrente e checkpoints completos.
- `runCampaignPortfolioGrowthCycle`: saúde diária e expansão semanal.
- `rebuildHourlyMetricsFromReports`: atualização horária incremental e rebuild diário completo.

Não adicionar um novo job para uma etapa já invocada por um pipeline sem primeiro verificar `functions.invoke(...)` na função chamadora.
