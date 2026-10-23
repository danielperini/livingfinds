# Incidente 43000c02-c417-44a9-ad2a-505e6aecc860

## Diagnóstico informado

O diagnóstico de produção fornecido para esta correção registra timeout de
`manualStructureAudit` após 180000 ms, resultado remoto desconhecido de
`enforceCanonicalManualCampaigns`, bloqueio de reconciliation/arbitration e
OpenAI em `diagnostic_only` com `gpt-6-luna`. Nenhuma alteração Amazon foi
confirmada. Esses fatos foram relatados; esta branch não consultou produção.

## Causa identificada no código e correção

O motor chamava a migração canônica como auditoria de estrutura. Essa função
processava retries, criava campanhas, arquivava keywords e iniciava negativas,
com esperas por keyword. Limitar a quantidade de campanhas não limitava a
quantidade de keywords nem a duração total. O timeout do motor apenas detectava
o prazo; não cancelava esse trabalho.

O ciclo agora exige `audit_only`. A função retorna a detecção local antes de
consultar a Amazon, processar retries ou gravar dados. `dry_run` e chamadas do
orquestrador também impõem essa fronteira. A resposta distingue candidatos
locais de campanhas que ainda exigem verificação remota; não declara migração
ou alteração confirmada. A migração legada explícita continua disponível fora
desse caminho. Falhas de leitura local deixam de virar listas vazias de sucesso.

Qualquer etapa que devolva incerteza remota bloqueia as seguintes, mesmo sem
timeout local. O motor propaga `remote_outcome: unknown` até o ciclo canônico e
o consumidor do ledger, evitando que o término da resposta descarte a incerteza.
Reconciliation/arbitration não começam nesse estado. A supervisão diagnóstica
continua disponível e não transforma diagnóstico em confirmação remota.

O comportamento do PR #173 permanece: revisão IA por conta e falhas da IA fora
dos critérios de sucesso das etapas centrais. Não foi alterado provedor/modelo.

## Validação reproduzível

```bash
deno test --config server/tests/canonicalIncident/deno.json --allow-env=MOTOR_STAGE_TIMEOUT_MS server/tests/canonicalIncident/incident.test.ts
deno test --config server/deno.json base44/shared/canonicalCyclePolicy.test.ts server/src/motorRunPolicy.test.ts
deno check --config server/deno.json base44/functions/enforceCanonicalManualCampaigns/entry.ts base44/functions/runUnifiedDecisionEngine/entry.ts base44/functions/runCanonicalDecisionCycle/entry.ts
```

A suíte do incidente carrega os handlers reais com SDK mockado e sem permissão
de rede. Cobre auditoria sem escritas, falha de leitura, timeout simulado de
180000 ms, conclusão tardia sem retry, incerteza explícita, bloqueio das etapas
posteriores e regressão do PR #173. Está incluída no CI.

Validação local antes da publicação: 10 testes de `canonicalIncident` passaram,
19 testes de regressão passaram e o `deno check` dos três módulos passou.
`git diff --check` não apontou erros. O build completo do frontend não foi
validado: Node/npm não estão disponíveis neste ambiente. Esses checks locais
não demonstram que o CI remoto passou.

Não houve merge, deploy, migração de banco nem chamada real à Amazon. Os testes
não reconciliam o incidente histórico: seu estado remoto continua exigindo
verificação antes de qualquer repetição operacional. Não há evidência de
integração ou de correção confirmada em produção nesta branch.
