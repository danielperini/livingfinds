# Auditoria de ativação do motor de decisão

Data da auditoria: 2026-07-30  
Branch: `agent/probabilistic-decision-engine`

## Escopo e evidência

Esta auditoria distingue código existente de capacidade operacional comprovada. Foram
inspecionados entrypoints, chamadas `functions.invoke`, entidades, catálogo de ações,
fila, confirmador, rollback, schedules e testes.

Os logs remotos e as datas de última/próxima execução não puderam ser comprovados:
a sessão Base44 local não estava autenticada e o comando `whoami` ficou aguardando
login. Por isso, nenhum componente é classificado como `ACTIVE` apenas por existir
em código ou no arquivo de schedule.

## Fluxo canônico comprovado em código

```text
amazon-automation-schedule.json
  -> runMotorImediato
  -> syncAdsCampaignStatesV2
  -> runDeterministicDecisionEngine
  -> OptimizationDecision
  -> executeApprovedDecisionQueue
  -> executeAutopilotDecision (router)
  -> executor específico
  -> confirmExecutedDecisions
```

Correções desta auditoria:

- o scheduler passou a ser aceito por `runMotorImediato` via `_service_role`;
- o motor passou a adquirir e liberar `AmazonSchedulerLock` com chave e owner;
- a camada IA passou de autoaprovação para `shadow_only`;
- o monitor de tendência deixou de disparar o redutor legado em paralelo;
- o painel de saúde deixou de executar decisões ao ser aberto;
- a confirmação ganhou espera mínima de propagação, estado persistido e ausência
  remota tratada como falha;
- retries cegos foram removidos: divergências retornam ao próximo ciclo canônico;
- ações sem probe completo foram bloqueadas no catálogo;
- confirmação canônica foi agendada a cada 10 minutos.

## Matriz de ativação

| Componente | Implementação e entrada | Chamada/trigger | Dados e gravações | Escrita/confirmador | Status |
|---|---|---|---|---|---|
| Metric engine | `runDeterministicDecisionEngine` + `decisionMetrics.ts` | `runMotorImediato`, `runUnifiedDecisionEngine`, portfolio | Campaign/Targeting/Unified metrics -> OptimizationDecision | pela fila | SCHEDULED |
| Economic same-SKU engine | `economicDecisionState.ts`, campos em `TargetingMetricsDaily` | importado pelo motor | same-SKU quando produtor fornece; caso contrário `unknown` | bloqueia crescimento com atribuição incompleta | CONNECTED |
| Metric quality | validações dispersas no motor; `buildAuditedDecisionContext` separado | contexto auditado só por orquestrador legado | qualidade/frescor parcial | não é gate único | CONNECTED |
| Attribution maturity | `decisionStatistics.ts` | motor determinístico | histórico de targeting -> mature clicks | influencia redução/pausa | CONNECTED |
| Goal policy resolver | `goalPolicyResolver.ts` | motor determinístico | PerformanceSettings + break-even | limita ACoS/CPC/bid | CONNECTED |
| Preset resolver | presets internos do goal resolver | motor determinístico | objective -> preset v1 | sem expiração por SKU | IMPLEMENTED_ONLY |
| Portfolio metrics | `portfolioBudgetPacing.ts` e ciclos intradiários | schedule `runIntraDayPacingCycle` | métricas/cap/controller | caminho próprio de pacing | SCHEDULED |
| DecisionEvidencePacket | inexistente como contrato canônico | nenhuma | campos dispersos em OptimizationDecision | — | NOT_IMPLEMENTED |
| ProfitabilityDecisionAgent | responsabilidade embutida no motor | motor | métricas econômicas | proposta no motor | IMPLEMENTED_ONLY |
| DeliveryCoverageDecisionAgent | zero-delivery bootstrap | schedule a cada 3h | campanhas/keywords | caminho especializado | SCHEDULED |
| BudgetPacingDecisionAgent | pacing functions | schedules intradiários | controller/portfolio | escreve por caminho próprio | SCHEDULED |
| DaypartPlacementDecisionAgent | dayparting canônico; placement parcial | pacing chama dayparting | HourlyMetric e controller | daypart escreve fora da fila; placement bloqueado | CONNECTED |
| GrowthHarvestingDecisionAgent | factory/portfolio/harvest | diário/semanal | SearchTerm/KeywordBank | criação/negativa fora do catálogo canônico | CONNECTED |
| InventoryEligibilityDecisionAgent | offer sync + stock guard | 10/15 min | Product/offer/inventory | guardas especializados | SCHEDULED |
| PortfolioAllocationDecisionAgent | portfolio growth/pacing | diário e semanal | campanha/search term | caminhos especializados | CONNECTED |
| OrganicRankDecisionAgent | não encontrado | nenhuma | — | — | NOT_IMPLEMENTED |
| runDecisionArbiter | não encontrado como componente | nenhuma | conflito parcial na fila | apenas lote aprovado atual | NOT_IMPLEMENTED |
| amazonActionRegistry | `amazonActionRegistry.ts` | fila canônica | definição de capacidade | gate antes do executor | CONNECTED |
| Canonical executor | queue -> router -> executores | motor horário + janelas | OptimizationDecision | Amazon Ads API | SCHEDULED |
| Confirmation probes | bids, estado keyword, campanha e budget | motor + schedule 10 min | releitura Amazon | persiste `confirmation_status` | SCHEDULED |
| Rollback | `rollbackLastChange` | sem trigger canônico | BidHistory/CreationLog | manual, sem avaliação automática | IMPLEMENTED_ONLY |
| Coverage engine | zero-delivery + portfolio | schedules | campanhas/termos | parcialmente separado | SCHEDULED |
| Zero-delivery recovery | `runManualZeroDeliveryBootstrap` | 3h e portfolio | entrega/bids | possui guardas e testes | SCHEDULED |
| Campaign replacement | lifecycle/replacement functions | sem trigger canônico único | lifecycle/log | confirmação variável | CONNECTED |
| Budget constrained winners | motor determinístico | motor horário | campaign metrics | budget pela fila | CONNECTED |
| Harvesting | factory/portfolio/promotions | diário/semanal | SearchTerm/KeywordBank | fora do catálogo canônico | SCHEDULED |
| Negative targeting | funções de promoção/learning | chamadas especializadas | search terms | bloqueado na fila canônica por falta de probe genérico | BLOCKED |
| Dayparting | `runCanonicalDaypartingEngine` | pacing intradiário | HourlyMetric | escreve por executor próprio | SCHEDULED |
| Placement | decisões presentes em funções legadas | sem executor/probe canônico | placement metrics parciais | bloqueado no action registry | BLOCKED |
| Bidding strategy | funções específicas | chamadas manuais/legadas | campaign config | sem registro/confirmador canônico | CONNECTED |
| Target lifecycle | várias funções e entidades | chamadas dispersas | target/keyword lifecycle | sem árbitro único | CONNECTED |
| Outcome evaluator | `evaluateDecisionOutcomes` | somente orquestradores legados/manual | CampaignMetricsDaily | não chama Amazon | CONNECTED |
| Learning engine | factory/auto learning/rule performance | diário/semanal parcial | LearningEvent/DecisionRule | múltiplos produtores | CONNECTED |
| Health dashboard | `SystemHealthV2.jsx` | abertura manual | entidades/logs/locks | agora read-only | CONNECTED |

## Catálogo de ações canônicas

| Ação | Executor | Endpoint | Idempotência/fila | Probe | Rollback declarado | Estado |
|---|---|---|---|---|---|---|
| set/reduce/increase/update bid | paired bid executor | `/sp/keywords` e paridade ad group | sim | keyword bid | set bid | habilitada |
| set/reduce/increase/update budget | executor V2 | `/sp/campaigns` | sim | campaign budget | set budget | habilitada |
| pause/enable campaign | pause safe/V2 | `/sp/campaigns` | sim | campaign state | ação inversa | habilitada |
| pause/enable keyword | executor V2 | `/sp/keywords` | sim | keyword state | ação inversa | habilitada |
| negative exact/keyword | executor V2 | `/sp/negativeKeywords` | parcial | ausente | não reversível | bloqueada |
| create keyword | harvest delegate | `/sp/keywords` | parcial | ausente no confirmador | pause keyword | bloqueada |
| apply dayparting | daypart delegate | `/sp/keywords` | caminho próprio | ausente no confirmador genérico | set bid | bloqueada na fila |
| placement | não registrado como suportado | `/sp/campaigns` | ausente | ausente | legado manual | bloqueada |

Regra de falha aplicada: nenhuma ação permanece `supported=true` se exigir confirmação
e não declarar um probe existente.

## Schedulers

Timezone declarado: `America/Sao_Paulo`.

| Função | Cadência | Papel | Lock/idempotência | Status estático |
|---|---|---|---|---|
| pollAmazonAdsReportJobs | 10 min | relatórios | retry interno | SCHEDULED |
| ensureDailyReportsCurrent | 00:01 + horário 07–23 | frescor | proteção interna parcial | SCHEDULED |
| enforceSkuProfitProtection | 15 min | proteção SKU | idempotência de decisão | SCHEDULED |
| runManualZeroDeliveryBootstrap | 3h | recuperação de entrega | idempotência própria | SCHEDULED |
| syncAmazonIntradayCampaignMetrics | 15 min | intraday | lock/retry interno | SCHEDULED |
| runMotorImediato | horário :25 | fluxo canônico | lock corrigido | SCHEDULED |
| confirmExecutedDecisions | 10 min | confirmação remota | ignora <5 min; sem retry cego | SCHEDULED |
| syncAmazonOfferAvailability | 10 min | elegibilidade | sem lock explícito | SCHEDULED |
| autoStockCampaignGuard | 10 min + 07:00 | pausa por elegibilidade | lock de produto parcial | SCHEDULED |
| runCampaignPortfolioGrowthCycle | diário + semanal | cobertura/harvest | sem lock global | SCHEDULED |
| rebuildHourlyMetricsFromReports | horário + diário | daypart data | upsert esperado | SCHEDULED |
| runIntraDayPacingCycle | 30 min + checkpoints | pacing/daypart | controller parcial | SCHEDULED |
| processAmazonNightWindow | 00/01/02/03/13h | fila de janela | depende da fila | SCHEDULED |
| demais jobs de relatório/economia | diário | dados/relatórios | variável | SCHEDULED |

Riscos de scheduler ainda existentes:

- vários jobs especializados podem escrever na Amazon fora do catálogo/fila;
- portfolio e motor horário podem gerar decisões próximas no tempo;
- nem todos os jobs possuem lock, timeout e dead-letter explícitos;
- schedules no repositório não provam que foram publicados no Base44;
- última e próxima execução dependem de logs remotos ainda não acessíveis.

## Agentes e metas

Os oito agentes especializados solicitados não existem como unidades formais e não
recebem um `DecisionEvidencePacket`. Suas responsabilidades estão distribuídas entre
funções. Portanto não é possível provar os 13 requisitos por agente.

A camada IA de `runMotorImediato` foi configurada para operar em shadow, mas permanece
classificada como `SCHEDULED` até que uma execução remota seja comprovada:

- não executa Amazon diretamente;
- sugestões são persistidas como `proposed`;
- `approval_status=shadow_only`;
- `execution_mode=MANUAL_REVIEW`;
- não entram na fila automática;
- continuam sem EvidencePacket/arbiter e não podem ser promovidas a ACTIVE.

## Teste de fluxo e cenários

Cobertura automatizada existente/complementada:

- lucro com zero pedidos;
- posterior bayesiano e maturidade;
- redução antes de prejuízo integral;
- pausa somente após intervenção anterior;
- Kalman para pressão persistente de CPC;
- estados econômicos e BUYABLE;
- conflito de metas e limite econômico;
- P0 cancelando crescimento;
- catálogo recusando ações sem executor/probe;
- probe obrigatório para toda ação suportada.

Ainda faltam fixtures ponta a ponta para:

- replacement antes de pausa;
- harvesting seguido de negativa confirmada;
- preset expirado e override por SKU;
- decisão ineficaz seguida de rollback automático;
- placement/bidding strategy;
- fluxo same-SKU completo com produtor real;
- dead-letter e concorrência entre jobs.

## Tabela final obrigatória

| FUNCIONALIDADE | IMPLEMENTADA | CONECTADA | AGENDADA | EXECUTANDO | CONFIRMADA | AVALIADA | STATUS |
|---|---:|---:|---:|---:|---:|---:|---|
| Motor métrico/econômico | sim | sim | sim | não comprovado em log | n/a | parcial | SCHEDULED |
| Maturidade/Bayes/Kalman | sim | sim | via motor | não comprovado | n/a | testes | CONNECTED |
| Metas/presets | sim | sim | via motor | não comprovado | n/a | testes | CONNECTED |
| IA aditiva | sim | sim | via motor | não comprovado; shadow configurado | não escreve | não | SCHEDULED |
| Fila/executor canônico | sim | sim | sim | não comprovado | parcial | parcial | SCHEDULED |
| Bids | sim | sim | sim | não comprovado | probe presente | parcial | SCHEDULED |
| Budget/campaign state | sim | sim | sim | não comprovado | probe presente | parcial | SCHEDULED |
| Keyword state | sim | sim | sim | não comprovado | probe presente | parcial | SCHEDULED |
| Negativas/create keyword | sim | parcial | parcial | bloqueado na fila | probe ausente | parcial | BLOCKED |
| Dayparting | sim | sim | sim | não comprovado | caminho próprio | parcial | SCHEDULED |
| Placement | parcial | não | não | não | não | não | BLOCKED |
| Outcome/learning | sim | parcial | não canônico | não comprovado | n/a | parcial | CONNECTED |
| Rollback automático | parcial | não | não | não | não | não | IMPLEMENTED_ONLY |
| Health dashboard | sim | sim | manual | read-only | lê confirmações | n/a | CONNECTED |

## Conclusão

O motor **não deve ser declarado totalmente ativo**. O núcleo determinístico, a fila
e os probes principais estão conectados e agendados no repositório, mas a execução
remota ainda precisa ser comprovada por logs Base44. Agentes formais, árbitro,
EvidencePacket, placement, rollback automático e confirmação de negativas/criação
de keyword permanecem incompletos ou bloqueados.
