# Estado atual, histórico e diagnóstico do dashboard

## Origem dos problemas

O painel usava `/health.daily_motor`, originado em `scheduler_job_runs`, como
explicação do que o motor fazia “agora”. Um ciclo encerrado não representa uma
execução atual. O feed ainda filtrava bloqueios locais e agrupava registros
históricos, enquanto as consultas de decisões e métricas paravam em 5.000
linhas. Outros widgets paravam em 1.000/2.000/3.000 linhas ou escondiam falhas
com listas vazias. Portanto, um recorte vazio não demonstrava ausência de histórico.

A contagem principal de campanhas vem de `loadAllCampaigns`: remove
`api_missing`/`excluded_from_dashboard` e deduplica o ID remoto. O contador
“ativas” usa `classifyCampaigns`: habilitadas mais incompletas. “Produtos com
estoque” conta produtos locais com `status=active` e `fba_inventory>0`; isso
não prova elegibilidade para ativação. Os números relatados (679, 143 e 11)
não foram verificados em produção nem substituídos por valores artificiais.

## Alterações

- Modelo de leitura combina o último ciclo do scheduler, lease de execução
  atual e runs com estado remoto desconhecido. Retorna data, idade, correlação,
  motivo do bloqueio, `is_running` e `current_execution_known`.
- Estados separados: `historical_exhausted`, `running`, `succeeded`,
  `blocked_remote_unknown`, `reconciliation_pending`, `no_recent_decisions`,
  `data_stale` e `scheduler_error`. Mais de um pode coexistir: um ciclo atual
  não apaga uma incerteza histórica.
- O estado histórico relatado de 23/10/2026 permanece `exhausted`,
  `remote_outcome=unknown`, `replay=blocked`, `reconciliation=pending`.
  Não existe atualização desse registro no novo fluxo. A proteção do scheduler
  também impede retry/catch-up de erros que declaram incerteza remota.
- `GET /api/motor-status?account_id=...` é autenticado e somente leitura.
  `/health` mantém o contrato existente e passa a distinguir último ciclo de
  execução atual. Os novos leitores não chamam os helpers `ensure*`, pois eles
  podem criar tabelas ou reconciliar registros antigos.
- `GET /api/motor-cycle-evidence?account_id=...&date=2026-10-23&source=decisions`
  lista evidência por páginas de 250. `source` aceita `decisions`, `claims` e
  `history`; `offset` navega e `correlation_id` limita a correlação exata.
  Sem correlação registrada, a resposta identifica os registros como candidatos
  da data local, sem atribuir causalidade. Campos retornados são limitados a
  identificadores, status, datas e request IDs, sem payloads, secrets ou leases.
- `getMotorDashboardStatus` e `getMotorCycleEvidence` são proxies de leitura
  para esses GETs; não iniciam motor, executor, arbitragem, criação ou reconciliação.
- Paginação usa o contrato real `filter(queryObject, sortString, limit, offset)`.
  O teste reproduz `sort.startsWith is not a function` com a chamada incorreta
  e comprova a leitura correta de mais de 5.000 linhas. Página repetida,
  erro ou limite de segurança gera falha explícita, nunca histórico vazio.
- Feed apresenta decisões bloqueadas e preserva o histórico carregado. Contadores
  de decisões recentes, históricas, bloqueadas, confirmadas, enviadas e ainda não
  confirmadas são separados. Envio é contado por decisão com evidência de envio;
  `attempt_count` e aprovação local não comprovam envio. Logs de bid não duplicam
  esses contadores. A limpeza destrutiva saiu deste painel de leitura; exportação
  CSV permanece.
- “Atualizar dados atuais” invalida consultas locais e recarrega o status. Não
  sincroniza Amazon, executa motor ou altera dados. Timestamp de campanhas,
  produtos, decisões e estoque é apresentado com `data_stale` e erros por fonte.

## Validação local

- 25 testes Node (6 específicos, 19 regressões) passaram.
- 38 testes Deno (6 específicos, 32 regressões de scheduler/ledger/ciclo) passaram.
- 10 regressões de `canonicalIncident` passaram, incluindo os PRs #173/#174.
- 6 testes PostgreSQL passaram: 1 específico de dashboard e 5 regressões de
  idempotência, claims, recuperação e migrações em banco descartável.
- O teste de dashboard usa transação `READ ONLY`, 6.283 decisões sintéticas,
  paginação de evidência e comparação do registro histórico antes/depois.
- `deno check` dos módulos afetados e build Vite passaram. Node/npm foram
  disponibilizados em `/tmp`; dependências instaladas pelo lockfile, sem mudar
  o lockfile. O build avisa sobre app ID ausente e tamanho de chunks; não é
  evidência de integração ou produção.
- `git diff --check` sem erros. CI remoto ainda precisa ser observado no PR.

Não houve chamada real à Amazon, mudança em campanhas, alteração do banco de
produção, replay do ciclo de 23/10, deploy ou merge. Nenhum resultado foi
declarado confirmado em produção. A reconciliação operacional continua pendente
fora desta correção de leitura. Os PRs #173 e #174 são ancestrais desta branch.
