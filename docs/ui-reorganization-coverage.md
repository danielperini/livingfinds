# Living Finds — inventário e cobertura da reorganização da interface

Baseline da branch `main` em 12/10/2026; implementação atualizada na branch `codex/ui-layout-architecture`. Auditoria estática do código; comportamento em produção não é inferido apenas pela existência de componentes. A matriz acompanha a reorganização, não autoriza mudanças em regras de negócio ou na Amazon.

## Escopo e arquitetura observada

- Frontend: React 18, Vite e React Router 6; `src/App.jsx` mantém os provedores de autenticação/tema/query, o splash, as rotas públicas/protegidas e `ProtectedRoute`.
- Backend: servidor Deno em `server/`; `server/src/registry.ts` carrega funções dinamicamente de `base44/functions/*/entry.ts`. O caminho de produção é VPS Hostinger; a pasta `base44/` preserva contratos e implementação compatíveis, não significa hospedagem Base44.
- Inventário de superfície: 45 rotas registradas, incluindo auxiliares/redirects; 39 arquivos de página; 446 entradas de função e 154 arquivos em `base44/shared`; 117 arquivos-fonte possuem ocorrência de `functions.invoke` (inclui README com exemplos, então não equivale a 117 chamadas executáveis). O grafo completo de leitura/escrita de cada função precisa ser completado antes de qualquer remoção ou mudança de lógica.
- Dependências já disponíveis: React, Router, TanStack Query, Tailwind, Radix/shadcn, Lucide, Recharts, Framer Motion e date-fns. Nenhuma dependência visual nova é necessária.
- Estado da instalação: o health check/segredos da VPS só devem ser consultados por endpoint administrativo de leitura. Valores de variáveis e tokens não devem entrar em catálogo, logs ou testes.

## Navegação atual e proposta

O menu atual expõe Dashboard, Produtos, Publicidade, Motor e Finanças, mais Configurações no rodapé. Há links de ação no cabeçalho para a Central de Decisões e um botão de notificações sem handler visível. A navegação proposta agrupa capacidades sem retirar páginas ou atalhos profundos; rotas de compatibilidade permanecem.

| Capacidade atual | Rota/componente atual | Ação/função existente observável | Jornada destino | Destino proposto | Tratamento | Estado atual | Verificação |
|---|---|---|---|---|---|---|---|
| Login | `/login` — `Login` | autenticação | Auxiliar pública | manter fora da sidebar | PRESERVAR | código presente; teste de produção pendente | rota pública em `App.jsx` |
| Cadastro | `/register` — `Register` | criação de conta | Auxiliar pública | manter fora da sidebar | PRESERVAR | código presente; teste pendente | rota pública em `App.jsx` |
| Recuperação de senha | `/forgot-password` — `ForgotPassword` | solicitação de recuperação | Auxiliar pública | manter fora da sidebar | PRESERVAR | código presente; teste pendente | rota pública em `App.jsx` |
| Redefinição de senha | `/reset-password` — `ResetPassword` | redefinição | Auxiliar pública | manter fora da sidebar | PRESERVAR | código presente; teste pendente | rota pública em `App.jsx` |
| Callback Ads | `/amazon-ads-callback` — `AmazonAdsCallback` | OAuth callback | Integração | manter rota externa exata | PRESERVAR | código presente; Amazon live não testada | rota antes do guard |
| Conta/estado geral | `/` — `Dashboard` | métricas e sincronização | OPERAR | Dashboard de operação | REORGANIZAR sem reimplementar consultas | código presente; produção não testada aqui | `Dashboard.jsx` e hooks chamados |
| Produtos | `/products` — `ProductsScheduled` → `Products` | catálogo, estoque, campanhas e Kick-off | OPERAR | Produtos e estoque | REORGANIZAR; preservar wrapper DOM até migração provada | comportamento misto React/MutationObserver | wrapper em `App.jsx`, `ProductsScheduled.jsx` |
| Estoque e vendas | `/inventory` — `InventorySales` | sincronização SP-API, vendas e disponibilidade | OPERAR | Estoque | REORGANIZAR | código presente; chamadas externas não testadas | rota e componente |
| Publicidade | `/ads` — `AdsManagement` | campanhas, termos, ações Amazon | OPERAR | Campanhas | REORGANIZAR; preservar confirmações | escrita real possível; sem teste de mutação | rota e `functions.invoke` no domínio Ads |
| Autopilot | `/autopilot` — `AdsAutopilotScheduled` | regras, guardrails e decisões | CONFIGURAR | Autonomia e proteção | REORGANIZAR; nenhuma regra alterada | código presente; efeito remoto não testado | rota e componentes autopilot |
| Repricing | `/repricing` — `Repricing` | preço e configuração | OPERAR | Repricing operacional; settings em Configurar | SOBREPOSIÇÃO parcial, manter detalhes | código presente; efeito remoto desconhecido | rota e componentes de economics |
| Análise financeira | `/analytics` — `Analytics` | ACoS/TACoS, gráficos e vendas | ANALISAR | Desempenho e finanças | REORGANIZAR; manter janelas/fontes | scripts DOM ativos | rota, entrypoints e componentes analytics |
| Bid logs | `/bid-logs` — `BidLogs` | histórico de lances | ANALISAR | Histórico de Ads | PRESERVAR recurso | código presente; fonte de dados precisa validação | rota e componente |
| Métricas | `/metrics` — `MetricsDashboard` | métricas e gráficos | ANALISAR | Métricas | PRESERVAR recurso | código presente | rota e componente |
| Search terms | `/search-terms` — `SearchTerms` | relatórios de termos | ANALISAR | Termos de busca | REORGANIZAR | código presente; granularidade não revalidada | rota e chamadas da página |
| Diagnóstico | `/diagnostico` — `Diagnostico` | diagnósticos | ANALISAR | Diagnósticos | PRESERVAR | código presente | rota e componente |
| Relatórios | `/report` — `Report` | relatórios/sync | ANALISAR | Relatórios | PRESERVAR | código presente; períodos precisam ser verificados | rota e componente |
| Logs | `/logs` — `Logs` | auditoria operacional | ANALISAR | Histórico e logs | PRESERVAR | código presente | rota e componente |
| Configurações | `/settings` — `SettingsIntegrated` | metas, Ads, economia, integrações | CONFIGURAR | seções por finalidade | REORGANIZAR; preservar persistência existente | múltiplos fluxos de gravação; precisa teste por seção | rota e componentes filhos |
| Usuários | `/users` — `Users` | acessos | CONFIGURAR | Usuários e permissões | PRESERVAR | código presente; permissão não testada | rota guardada |
| Setup SP-API | `/sp-api-setup` — `SpApiSetup` | autenticação SP-API | CONFIGURAR | Conexões Amazon | PRESERVAR URL | fluxo externo sensível, não testar com escrita | rota guardada |
| Autorização própria SP-API | `/sp-api-self-auth` — `SpApiSelfAuth` | autorização externa | CONFIGURAR | Conexões Amazon | PRESERVAR URL | fluxo externo não testado | rota guardada |
| Integração Amazon | `/integracoes/amazon` — `AmazonIntegracao` | conexão/status Amazon | CONFIGURAR | Conexões Amazon | REORGANIZAR visualmente | código presente; token real não exposto | rota guardada |
| Saúde do sistema | `/saude-do-sistema` — `SystemHealth` | jobs, estado do sistema | ANALISAR | Saúde e sincronizações | PRESERVAR | código presente; produção não testada | rota guardada |
| Configuração de campanhas | `/configuracao-de-campanhas` — `CampaignConfig` | configurações Ads | CONFIGURAR | Orçamento/limites/campanhas | REORGANIZAR sem duplicar gravadores | gravação necessita teste de regressão | rota e painel |
| Dayparting legado | `/dayparting` | redirect para `/settings` | Compatibilidade | destino de configuração canônico | REDIRECT preservado | redirect presente | regra em `App.jsx` |
| Manual | `/manual` — `ManualInstrucoes` | documentação | ANALISAR | Ajuda | PRESERVAR | código presente | rota guardada |
| Pipeline | `/optimizer` — `OptimizerPipeline` | pipeline/otimização | ANALISAR | Decisões e pipelines | PRESERVAR recurso distinto | código presente; efeitos não foram testados | rota guardada |
| Auditoria de moeda | `/currency-audit` — `CurrencyAudit` | auditoria de moeda | ANALISAR | Finanças/qualidade de dados | PRESERVAR | código presente | rota guardada |
| Keywords | `/keyword-management`, `/KeywordManagement` — `KeywordManagement` | lances/keywords | OPERAR + ANALISAR (manter a rota única) | Campanhas/Term Intelligence | SOBREPOSIÇÃO parcial; recursos não fundir sem equivalência | rota duplicada por capitalização; mesma página | ambas as rotas em `App.jsx` |
| OAuth Ads | `/amazon-oauth-setup` — `AmazonOAuthSetup` | conexão Ads | CONFIGURAR | Conexões Amazon | PRESERVAR URL | integração não testada | rota guardada |
| Term bank legado | `/term-bank` | redirect para `/campaign-factory` | Compatibilidade | Kick-off e expansão | REDIRECT preservado | redirect presente | `App.jsx` |
| Fábrica de campanhas | `/campaign-factory` — `CampaignFactory` | propostas/criação de campanhas | OPERAR | Campanhas e Kick-off | REORGANIZAR; preservar política/autorização | escrita possível; sem ação real | rota e componentes factory |
| Daypart por ASIN | `/daypart-crossasin` — `DaypartCrossAsinPage` | análise/configuração temporal | CONFIGURAR + ANALISAR | Dayparting | PRESERVAR recurso próprio | código presente; gravação a validar | rota guardada |
| Listing enhancement | `/products/listing-enhancement` — `ListingEnhancementPage` | conteúdo do catálogo | OPERAR | Produtos/listings | PRESERVAR | código presente; chamadas não testadas | rota guardada |
| Autorização Ads | `/settings/ads-authorization` — `AdsAuthorizationPage` | escopo/autonomia Ads | CONFIGURAR | Autonomia e permissões | PRESERVAR | acesso guardado | rota guardada |
| Keyword ML | `/keyword-ml` — `KeywordMLDashboard` | inteligência de termos | ANALISAR | Term Intelligence | PRESERVAR como detalhe | código presente | rota guardada |
| Central de decisões | `/sala-de-comando` — `SalaDeComandoPremium` | decisões, riscos, alertas | OPERAR + ANALISAR | visão de operação e histórico | REORGANIZAR | uso produtivo não testado | rota guardada |
| Sala legada | `/sala-de-comando/legacy` — `SalaDeComandoLegacy` | abas antigas e históricos | ANALISAR | histórico/diagnósticos | PRESERVAR | URL profunda é usada por redirects | `?tab=` mantido |
| Monitor Kick-off | `/kickoff-monitor` — `KickoffQueueMonitor` | fila/status | OPERAR | Kick-off e filas | PRESERVAR | código presente; ação não exercitada | rota guardada |
| Term intelligence | `/term-intelligence` — `TermIntelligence` | análise de termos | ANALISAR | Term Intelligence | PRESERVAR recurso próprio | código presente | rota guardada |
| Motor legado | `/strategy-engine`, `/strategy-engine-legacy` | redirect à sala com `?tab=estrategias` | Compatibilidade | Motor/histórico | REDIRECT preservando query relevante | redirects presentes | `App.jsx` |
| Pré-leitura semanal | `/prelecao-semanal` | redirect à sala com `?tab=prelecao` | Compatibilidade | Análise | REDIRECT preservado | redirect presente | `App.jsx` |
| Recomendações/aprendizado | `/recommendations`, `/learner`, `/motor-config` | redirects para `/autopilot` | Compatibilidade | Autonomia/configuração | REDIRECT preservado | redirects presentes | `App.jsx` |
| Alertas/logs/fila | `/alerts`, `/bids-log`, `/queue-monitor`, `/task-queue`, `/eficiencia-ia`, `/incomplete-campaigns` | redirects para páginas canônicas | Compatibilidade | Operar ou Analisar conforme alvo | REDIRECT preservado | redirects presentes | `App.jsx` |
| Transições | `/transitions` | redirect para `/products` | Compatibilidade | Produtos | REDIRECT preservado | redirect presente | `App.jsx` |
| Not found | `*` — `PageNotFound` | fallback | Auxiliar | manter | PRESERVAR | código presente | rota catch-all |
| Catálogo de APIs | inexistente | novo endpoint GET somente leitura | CONFIGURAR | `/configuracao/apis` | NOVO; segredo nunca exposto | não existe | implementar admin-only e testar sem Amazon |

## Scripts de DOM e estilos transversais

`src/main.jsx` carrega `dashboardSeparatedChartsEntry.jsx`, `installCampaignInsertionGuard`, `installGlobalTableSorting` e `installUnlimitedKeywordReads`. A árvore de entrypoints do Dashboard/Analytics contém MutationObservers que inserem gráficos/labels e removem duplicatas. `ProductsScheduled.jsx` também observa DOM e adiciona controles/fallbacks da fila. Classificação: **PRESERVAR até migrar cada efeito para React e verificar equivalência**; nenhum script será removido como código morto nesta iniciativa.

`src/main.jsx` importa, nesta ordem, `index.css`, `premium-theme.css`, `workspaces-premium.css`, `sortable-tables.css`, `app-premium-normalization.css`, `premium-system.css`, `authenticated-dark-contract.css`, `mondrian-charts.css`, e só então entrypoints de layout DOM. `index.css` define tokens claros (fundo #F5F6F8, ação #2563EB, sucesso #15803D), porém `tailwind.config.js` ainda ativa `darkMode: ["class"]`, mantém cores legadas (`cyan`, `green`, `amber`, `crimson`) e não mapeia os tokens semânticos `--text-*`, `--border-*`, `--success-*`. `authenticated-dark-contract.css` contém contrato escuro, `!important`, gradientes e remapeamentos globais. Isso conflita com o tema claro único; os consumidores serão migrados e testados antes de remover regras.

O `AppLayout` atual tem sidebar de 238px/76px sem persistência, não tem os grupos Operar/Analisar/Configurar, usa título de página em vez de breadcrumb, header de 68px, botão de notificações sem handler e CTA de Central global em todas as telas. O drawer não registra Escape/foco preso. A tela de Configurações também reaparece no rodapé e no menu, um atalho duplicado. Esses itens serão tratados sem retirar rotas ou ações.

## Backend e dados — limites do inventário

O servidor monta funções por diretório e usa autenticação compartilhada em `server/src/main.ts`/`server/src/sdk/functions.ts`; a rota de função passa por `apiAuthorized`/sessão ou token interno. Funções existentes podem alterar Amazon Ads/SP-API; não são analisadas como seguras por seu nome. Antes de criar `getEnvironmentStatus`, validar a autenticação administrativa e devolver somente nomes permitidos + booleano configured/missing, nunca o valor. O estado atual da VPS não é inferido localmente.

- Frontend consome `base44.functions.invoke(...)` em múltiplos domínios; o inventário estático é necessário mas não comprova chamadas bem-sucedidas, permissões ou efeito remoto.
- 446 funções e 154 módulos compartilhados requerem revisão de chamadas pelos caminhos das telas que serão reorganizadas; nenhuma fusão/exclusão será feita com base em nomes.
- O checkout Windows precisa excluir `base44/workflows/**` do working tree porque vários nomes contêm `:` e não podem ser materializados em NTFS. Seus blobs continuam preservados no Git. Essa limitação impede alegar auditoria arquivo a arquivo desses workflows nesta cópia; os arquivos de workflow não serão modificados. Schedules, deploy, auth e registry precisam ser consultados no Git/API quando uma tela depender deles.
- Variáveis encontradas por busca estática (nomes somente; estado real não verificável aqui): `ADMIN_PASSWORD`, `ADS_ACCOUNT_ID`, `ADS_CLIENT_ID`, `ADS_CLIENT_SECRET`, `ADS_PROFILE_ID`, `ADS_REFRESH_TOKEN`, `ADS_REGION`, `AI_WEEKLY_REVIEW_MODEL`, `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_MARKETPLACE_ID`, `AMAZON_SELLER_ID`, `AMAZON_SP_APP_ID`, `AMAZON_SP_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_FAST`, `API_TOKEN`, `APP_BASE_URL`, `BASE44_API_BASE`, `BASE44_API_KEY`, `BASE44_APP_ID`, `CA_ID`, `CA_NAME`, `CA_SECRET`, `CB_ID`, `CB_NAME`, `CB_SECRET`, `DATABASE_URL`, `DB_POOL_MAX`, `DEFAULT_USER_ID`, `DISCORD_WEBHOOK_URL`, `ENABLE_SCHEDULER`, `ENTITIES_DIR`, `FRONTEND_DIR`, `FUNCTIONS_DIR`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN`, `INTERNAL_FUNCTION_TOKEN`, `MAX_PER_ENTITY`, `NOME`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPERATION_MODE`, `PORT`, `SCHEDULER_DB_POOL_MAX`, `SCHEDULES_FILE`, `SERPER_API_KEY`, `SP_CLIENT_ID`, `SP_CLIENT_SECRET`, `SP_REFRESH_TOKEN`, `T1`, `T1_NAME`, `T2`, `T2_NAME`, `XANO_API_KEY`, `XANO_BASE_URL`, `VITE_BASE44_APP_BASE_URL`, `VITE_BASE44_APP_ID`, `VITE_BASE44_FUNCTIONS_VERSION`. Referências test/check scripts também aparecem e não necessariamente são produção. O catálogo separará runtime backend de variáveis do build e estado desconhecido.

## Fluxos que funcionam hoje — não tocar

- `AuthProvider`, `ThemeProvider`, `QueryClientProvider`, `Router`, `ScrollToTop`, `Toaster`, `AuthenticatedApp` (loading, usuário não cadastrado e splash), `ProtectedRoute`.
- Rotas públicas, callback OAuth, setups SP-API e redirects profundos; preservar URL, query e hash.
- Cliente e hooks de dados existentes, seleção/filtros/paginação dos produtos e campanhas, confirmações de escrita na Amazon, histórico e estado de dados desatualizados.
- Scripts de DOM com efeitos visíveis até haver migração React coberta por teste.
- Todas as regras econômicas, decisões, permissões e funções existentes de backend.

## Limites e verificações ainda pendentes

1. O mapa de chamadas de backend permanece por domínio. Esta entrega preserva os fluxos de dados e reorganiza rotas, mas não afirma que cada jornada foi validada com sessão real ou em produção.
2. O ThemeProvider e o contrato global de tema continuam preservados. O shell usa tokens claros próprios; a migração integral do tema legado não é parte desta entrega.
3. Foram corrigidos os controles sem ação observável no shell: notificações foi removido, e a sidebar/drawer agora tem controles operáveis. Um inventário completo de handlers de todas as páginas continua fora do escopo visual.
4. Workflows/schedules com nomes não materializáveis no NTFS não foram editados; o workflow CI convencional foi atualizado para executar os novos testes.
5. A paginação das tabelas não foi modificada. Os contratos existentes seguem cobertos pelos testes de paginação já presentes.
6. Capturas autenticadas 375px/768px/1280px ainda não foram executadas. A suíte `npm run ui:audit` exige Playwright e `PLAYWRIGHT_STORAGE_STATE`.

## Implementação em `codex/ui-layout-architecture`

- **Design tokens:** `src/styles/journey-layout.css` declara aliases semânticos para as cores e medidas usadas pelo shell novo. Os valores iniciais de cores em `src/index.css` já existiam antes desta iniciativa; os aliases não alteram o motor, páginas nem contrato do tema herdado.
- **Shell e jornadas:** `src/components/layout/AppLayout.jsx` usa sidebar e cabeçalho responsivos, breadcrumb contextual, botão de Central de Decisões e grupos Operar/Analisar/Configurar. A sidebar desktop recolhe e persiste a escolha. O drawer móvel fecha com Escape, tem foco inicial e contenção básica de Tab. Rotas existentes, wrappers, providers, splash, auth e Toaster foram preservados.
- **Cobertura de navegação:** `src/lib/navigation.js` mapeia os destinos operacionais e de configuração existentes. Aliases/redirects e callback OAuth permanecem no `App.jsx`. A tela de APIs foi adicionada em `/configuracao/apis`.
- **Catálogo de APIs:** `server/src/environmentStatus.ts` contém allowlist explícita; `GET /api/admin/environment-status` em `server/src/main.ts` exige usuário autenticado com role `admin`, retorna apenas nomes de variáveis e booleanos de presença, e envia `Cache-Control: no-store`. A página `src/pages/ApiCatalog.jsx` informa carregamento, erro/403 e última verificação sem exibir segredos. Não houve leitura do estado do VPS neste trabalho.
- **Validação local:** Vite build passou (aviso de bundle JS acima de 500 kB); `node --test` executou os contratos de paginação, projeção financeira, visibilidade do catálogo e navegação — 11 testes passaram. ESLint nos arquivos alterados passou. A verificação ESLint global aponta 153 erros preexistentes de imports não utilizados em outras páginas; o typecheck global reporta centenas de erros preexistentes, e a triagem das mensagens dos arquivos desta mudança corrigiu o único erro novo encontrado. A suíte Deno do status não pôde ser executada localmente porque Deno não está instalado; o CI foi atualizado para executá-la.
- **Limites ainda pendentes:** não foi possível capturar screenshot autenticado em 375/768/1280 px nem exercitar endpoint contra processo Deno real; Playwright e Deno não estão instalados neste runtime. A suíte `ui:audit` requer Playwright e `PLAYWRIGHT_STORAGE_STATE`. A inspeção estática não substitui teste de role/HTTP em integração. Nenhuma campanha, banco de produção, deploy ou segredo foi alterado.

## Fases e evidências

| Fase | Escopo | Arquivos esperados | Risco | Evidência/status |
|---|---|---|---|---|
| L0 | Rotas, capacidades, estilos, scripts DOM, integrações | este documento | inventário estático pode não comprovar execução remota | inventário inicial; gaps acima abertos |
| L1 | Tokens claros e mapeamento Tailwind | `src/index.css`, `tailwind.config.js`, estilos | alto impacto visual global | não iniciada |
| L2 | Biblioteca pequena reutilizável | `src/components/ui-kit/*` ou componentes existentes | regressão de estados/accessibility | não iniciada |
| L3-L4 | Shell, drawer, 3 grupos, redirects | `AppLayout.jsx`, `App.jsx` | acesso/URLs | não iniciadas |
| L5-L7 | Composição Operar/Analisar/Configurar sem trocar lógica | páginas/componentes | fluxos Amazon e configurações | não iniciadas |
| L8 | Catálogo + estado de ambiente admin read-only | página + nova função somente leitura + testes | credenciais | não iniciada; endpoint não pode escrever |
| L9-L11 | Migração DOM/CSS e regressão visual | entrypoints, páginas e testes | efeitos ocultos e telas não visitadas | não iniciadas |

## Critério de conclusão

A iniciativa só poderá ser declarada concluída após cada fase passar build/lint/testes, todas as rotas preservadas serem verificadas, capturas e teclado serem conferidos nos três viewports, os botões sem ação serem corrigidos ou declarados somente leitura, o catálogo reportar apenas estados reais e seguros, e o diff confirmar que nenhuma regra econômica/execução Amazon existente foi alterada. PR será aberto para revisão; não haverá merge nem deploy como parte desta iniciativa.
