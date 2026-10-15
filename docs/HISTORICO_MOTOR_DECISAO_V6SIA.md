# Histórico consolidado do motor de decisão do Living Finds

**Atualizado em:** 14 de outubro de 2026 (horário de São Paulo)
**Repositório revisado:** `danielperini/livingfinds`
**Base da revisão:** `d648fef9fee57c7b3dfba5a051eea7ec04330b2a`
**Branch desta correção:** `codex/durable-motor-run-observability`

## Propósito e limite da evidência

Este documento registra a evolução técnica identificável no repositório, as correções preparadas nesta branch e o que ainda precisa de confirmação operacional. Histórico Git, código e testes demonstram implementação ou comportamento local; não demonstram que o VPS executou uma mudança, que a Amazon confirmou uma escrita, nem que vendas ou lucro melhoraram.

O objetivo do motor é analisar dados válidos por conta, SKU/ASIN, campanha e termo; gerar decisões determinísticas com limites financeiros e de estoque; executar somente pelo fluxo autorizado; e reconciliar o estado remoto. A IA supervisiona análises e falhas, mas não substitui validações determinísticas. Nenhum sistema pode garantir lucro ou disponibilidade absoluta.

## Linha do tempo de mudanças identificadas

Os commits recentes abaixo são evidência diretamente verificável no histórico do repositório. O catálogo descreve sua intenção e não declara, por si só, sucesso em produção.

| Data | Commit | Trabalho registrado | Efeito buscado |
|---|---|---|---|
| 14/10/2026 | `d7862e2` | Auditoria diária de campanhas Amazon por SKU | Revisar cobertura e desempenho em escopo de produto. |
| 14/10/2026 | `2c48d7a` | Auditoria de entrega de campanhas por SKU | Identificar campanhas sem entrega e diferenças entre produtos. |
| 14/10/2026 | `4aa12a8` | Jornada de descoberta de campanhas FBA por SKU | Aplicar elegibilidade e descoberta com vínculo de produto. |
| 14/10/2026 | `3ee3d7a` | Correção da paginação de snapshots no Hostinger | Alinhar a coleta ao contrato de filtros por `sort`, `limit` e `offset`. |
| 14/10/2026 | `50135c9`, `c5cf35a` | Recuperação limitada de ciclos diários esgotados | Permitir retomada controlada do ciclo. |
| 14/10/2026 | `e5b1a1c`, PR #148 | Tratar corrida de idempotência no ciclo de campanhas | Reutilizar decisão existente quando outra execução já a criou. |
| 14/10/2026 | PR #149, `1ddd86f` | Otimização guiada por IA após relatórios diários | Usar evidência diária publicada antes de orientar otimização. |
| 14/10/2026 | `2d10857` | Seleção de data de relatórios Ads | Usar a data correta do relatório diário. |
| 14/10/2026 | `d648fef` | Redução de desperdício automático usando IDs remotos atuais | Evitar endereçar targets por identificadores locais inadequados. |

O histórico desta conversa também registra trabalhos anteriores sobre orçamento e margem, métricas agregadas, estoque FBA, separação de ASIN/SKU, jornada automática → termo vencedor → campanha manual, negativas, confirmação de alterações, agendamento e interface. Quando não há commit ou teste referenciado neste documento, esses itens são tratados como contexto relatado, não como confirmação independente de funcionamento atual.

## Fluxo de decisão e controles existentes

O código revisado contém o ciclo canônico V6SIA, que organiza política econômica, motor unificado, reconciliação, arbitragem e supervisão. O motor unificado aciona etapas de inventário, coleta/snapshots, avaliação econômica, estrutura de campanhas, políticas determinísticas, crescimento, entrega, dayparting e repricing. A execução de decisões aprovadas e a confirmação remota são funções separadas no contrato canônico.

As regras e testes existentes cobrem economia, elegibilidade de estoque, escopo de SKU, termos vencedores, crescimento, entrega, limites de campanha, confirmação e idempotência. A interface contém páginas de operação e análise, painéis de decisões e consulta de histórico. A cobertura e a qualidade variam por jornada; não se deve inferir que todo endpoint legado use automaticamente o fluxo canônico.

## Incidentes e evidências operacionais revisadas

### Execução #102

O log apresentado para o workflow de crescimento registra término após aproximadamente **9 min 10 s**, com falha. As linhas disponíveis mostram:

- `snapshots` falhou com `sort.startsWith is not a function` e zero linhas lidas; isso confirma a incompatibilidade do argumento de ordenação naquela execução.
- `campaignLifecycle` encontrou a restrição `optimization_decision_idempotency_unique`; isso confirma uma colisão de unicidade naquela execução, mas não prova que o mecanismo de idempotência atual falhe em todos os caminhos.
- O resumo daquele ciclo informa `engine_ok:false`, `executed:0` e `confirmed:0`. Isso prova que o resumo não registrou execuções ou confirmações. Não prova, sozinho, a ausência absoluta de qualquer requisição remota fora desses contadores.

### Execução #103

O run `38642234338` foi cancelado depois de aproximadamente **45 min 24 s**. O log disponível não contém o resultado final do motor. O estado de qualquer escrita remota desse ciclo permanece **não confirmado**; não se deve reenviar ações associadas sem reconciliação.

### Execução #104

O run `38671061010`, workflow `Proactive campaign growth cycle`, foi iniciado por `workflow_dispatch` em `2026-10-15T02:27:14Z` (**14/10/2026 23:27:14 BRT**). Na consulta feita durante esta revisão, o GitHub ainda mostrava `in_progress`, sem `conclusion`, com última atualização `2026-10-15T02:27:19Z`. A etapa do workflow executa uma sessão SSH longa e só imprime o resumo ao fim; os logs de uma tarefa ainda ativa não forneciam a etapa interna. Portanto:

- **ID e ambiente:** run GitHub Actions `38671061010`, branch `main`, commit `d648fef`, acionado manualmente.
- **Última etapa observável:** job único `Run, monitor and reconcile…`, ainda em andamento; etapa interna do motor não observável nos logs disponíveis.
- **Chamada pendente/erro:** não identificável com o acesso de logs consultado; ausência de log durante execução não identifica qual chamada está aguardando.
- **Ações enviadas à Amazon:** não confirmadas nem descartadas pelos metadados do run. Não assumir sucesso ou ausência de mutação.
- **Classificação:** processo/workflow ainda em andamento no momento da consulta; não há evidência suficiente para classificar como espera de relatório assíncrono, falha de polling ou processo encerrado.

## Correções preparadas nesta branch

Estas alterações estão no código local desta branch. Não foram implantadas na VPS nem executaram chamadas mutáveis à Amazon.

1. **Ledger durável no PostgreSQL:** registra `run_id`, chave idempotente, função, conta, estado, etapa, início, última atividade, tentativas, etapas resumidas, contadores, erros e resultado. A solicitação de início devolve o ID após gravar a execução; a consulta continua disponível após a requisição da interface terminar.
2. **Worker e posse:** um worker reserva linhas com `FOR UPDATE SKIP LOCKED`, usa lock transacional PostgreSQL por conta ao enfileirar e reservar, renova lease e não reexecuta trabalho interrompido. Ao reiniciar, registra execução interrompida e resultado remoto incerto quando a última etapa podia ter produzido escrita. Não acrescenta índice de unicidade sobre histórico preexistente.
3. **Estados honestos:** `queued`, `running`, `completed`, `partial`, `failed`, `interrupted` e `remote_unknown`. Uma requisição enviada não é apresentada como confirmação. Resultado incerto não é repetido automaticamente.
4. **Progresso por etapa:** o motor unificado salva início, duração, resultado compacto e erro de cada etapa. Se o ledger não aceitar o checkpoint, o motor não inicia a próxima etapa. Os limites são configuráveis por ambiente.
5. **Timeouts explícitos:** etapa e execução têm prazos configuráveis. `Promise.race` apenas detecta o prazo; não cancela o handler subjacente. Por isso um timeout é gravado como `remote_unknown`, bloqueia nova execução concorrente na mesma conta e exige reconciliação. O código não afirma que a operação subjacente foi cancelada.
6. **Paginação V6SIA:** usa o contrato real do repositório Hostinger (`filter(query, sort, limit, offset)`), deduplica por ID, detecta repetição, registros sem ID e limite de páginas; fonte incompleta não é declarada completa.
7. **Consulta na interface:** o painel operacional passa a consultar execuções persistidas e mostrar run ID, status, etapa, última atividade, falhas e incerteza remota. As telas que iniciam o motor usam o endpoint durável e retomam consulta de execução em andamento.
8. **Workflow:** a rotina de crescimento foi preparada para iniciar e acompanhar runs duráveis, imprimir progresso quando mudar e não repetir uma escrita incerta. O workflow não foi executado a partir desta branch.
9. **Orientação do projeto:** `AGENTS.md` e `README.md` passam a esclarecer a hospedagem Hostinger/Deno/PostgreSQL e a compatibilidade histórica da pasta `base44`.

## Como validar uma execução depois da implantação

1. Consultar `GET /api/motor-runs?account_id=<id>&limit=10` para localizar o run mais recente.
2. Consultar `GET /api/motor-runs/<run_id>` para obter o mesmo registro, etapa, timestamps, erros, resumo e `remote_outcome`.
3. Interpretar `queued` como aceito, não iniciado; `running` como trabalho com heartbeat; `completed` como processamento completo; `partial` como resultado misto; e `remote_unknown` como possível chamada remota sem confirmação.
4. Em `remote_unknown`, verificar o estado atual da campanha/target na Amazon e reconciliar antes de qualquer nova tentativa.
5. Confirmar depois do deploy que os runs agendados terminam e que a conta, perfil e marketplace esperados aparecem na execução. Não considerar o endpoint saudável apenas por responder HTTP 202.

## Validação local desta branch

Executado nesta revisão:

- `deno test --config server/deno.json base44/shared/v6siaEvidencePaging.test.ts server/src/motorRunPolicy.test.ts` — **13 testes passaram, 0 falharam**.
- `deno check --config server/deno.json` para servidor, funções de início/consulta, motor unificado e testes — **passou após correções de tipos**; repetir ao finalizar alterações.
- `git diff --check` — sem erros de whitespace antes das edições mais recentes; repetir ao finalizar.

Limitações do ambiente desta revisão:

- Não havia `npm` nem `docker` disponível; o build Vite e um PostgreSQL local para testes de concorrência/recuperação não puderam ser executados.
- Os testes de política simulam timeout, processamento de relatório, concorrência por escopo, reinício sem replay, falhas parciais e redação de segredo. Eles **não substituem** testes de integração com PostgreSQL real.
- O ambiente não foi implantado na VPS. Nenhuma migração de produção ou escrita à Amazon foi executada nesta tarefa.
- A aplicação não consegue provar, nesta branch, o estado atual do run #104 no Hostinger/Amazon; a API do GitHub consultada só confirmou o estado do workflow no instante da consulta.

## Pendências para concluir a validação de produção

- Executar a suíte de integração de banco em PostgreSQL descartável, cobrindo concorrência entre processos, lease expirado, recuperação após reinício e ausência de duplicidade.
- Confirmar que o workflow de deploy inclui as novas rotas e o worker no pacote publicado; implantar somente após revisão e checks verdes.
- Integrar a consulta de `run_id` também às demais telas e acionadores ainda diretos, especialmente o scheduler do servidor e caminhos legados. As mudanças atuais cobrem o workflow de crescimento e as telas de motor tocadas nesta branch; ainda não consolidam todos os agendadores e endpoints num único dispatcher.
- Confirmar as execuções agendadas após implantação e reconciliar os estados remotos do run #104 e de qualquer ação incerta.
- Confirmar em ambiente controlado compatibilidade de timeout/cancelamento dos handlers e cotas de API; este código não consegue cancelar automaticamente todas as operações subjacentes.
- Planejar atualização reversível do schema e backup PostgreSQL antes de habilitar o worker em produção. O DDL do ledger é aditivo, mas ainda não foi aplicado nem ensaiado em banco de produção.

## Critério para chamar o motor de operacional

Só declare uma jornada operacional confirmada quando houver: entrada aceita com `run_id`; heartbeat e etapas persistidos; coleta completa e atual; decisão com dados e configuração efetiva; ação enviada ou bloqueada com razão; confirmação remota ou estado desconhecido explicitamente resolvido; e resultado final consultável após atualização da tela. “Rotina agendada”, “workflow iniciado”, “requisição aceita” e “campanha ativa” são fatos diferentes e devem aparecer separados.
