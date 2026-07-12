import { useState } from 'react';
import {
  BookOpen, ChevronDown, ChevronRight, Zap, Brain, Target, TrendingUp,
  ShieldCheck, BarChart2, RefreshCw, AlertTriangle, CheckCircle, Clock,
  Settings, Layers, Activity, Package, DollarSign, Search, Shield,
  Star, ArrowRight, GitBranch, Cpu
} from 'lucide-react';

const VERSION = '2.0.0';
const VERSION_DATE = '12/07/2026';

const SECTIONS = [
  {
    id: 'visao-geral',
    icon: BookOpen,
    color: 'text-cyan',
    bg: 'bg-cyan/10 border-cyan/20',
    title: 'Visão Geral da Plataforma',
    subsections: [
      {
        title: 'O que é o LivingFinds?',
        content: `O LivingFinds é uma plataforma de gestão autônoma de anúncios Amazon. Toda decisão do sistema parte de uma única fonte de verdade: **Configurações > Metas de Performance (PerformanceSettings)**.

**Dois módulos operam em paralelo e independentes:**

**Módulo A — IA Semanal (Claude):** Analisa performance histórica de 30 dias, propõe regras estratégicas de longo prazo e as submete para aprovação do usuário antes de ativar. Roda toda segunda-feira.

**Módulo B — Motor Determinístico Estratégico v4:** Executa decisões de bid em tempo real usando regras matemáticas auditáveis, classificação de intenção de busca e metas econômicas dinâmicas por produto. Roda a cada hora.

**Princípio fundamental:** o Módulo A nunca interfere diretamente no Módulo B. O Módulo A propõe → passa por validação → usuário aprova → Módulo B executa.`
      },
      {
        title: 'Pipeline de Automações (Ciclo de Operação)',
        content: `**A cada hora — Pipeline de Bids (executeApprovedDecisionQueue)**
Executa todas as decisões aprovadas na fila sem restrição de janela horária. Prioridade: pausas e reduções críticas → aumentos → budget.

**A cada hora — Guardrails (runHourlyAdsGuardrails)**
Protege contra spike de gasto, pausa campanhas com produto sem estoque, monitora ações travadas.

**10:00 UTC diário — Sync Inventário + Kickoff (checkInventoryChangesAndKickoff)**
Sincroniza inventário FBA, detecta produtos reabastecidos e dispara kickoff automático.

**09:00 UTC diário — Pipeline completo (runDailyFullReportPipeline)**
Sync de campanhas → download de relatórios → métricas diárias → motor de decisão.

**Segunda-feira 08:00 UTC — Módulo A (runWeeklyClaudeRuleReview)**
Análise profunda com Claude, geração de regras, backtest, submissão para aprovação.

**Sexta-feira 22:00 UTC — Limpeza de termos (runWeeklyWasteTermsCleanup)**
Negativação automática de termos sem conversão com gasto > R$5.

**Sábado 10:00 UTC — Harvest de termos (updateTermBankFromAutomaticCampaigns)**
Importa termos vencedores (≥3 pedidos/30d) das campanhas AUTO para o TermBank.`
      }
    ]
  },
  {
    id: 'performance-settings',
    icon: Target,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/20',
    title: 'Metas de Performance — Fonte Única',
    subsections: [
      {
        title: 'Por que PerformanceSettings é a fonte única absoluta?',
        content: `Todo motor, guardrail e decisão do sistema lê primeiro **Configurações > Metas de Performance**. Não existe outra fonte de configuração ativa.

**Cascata de fallback (ordem de prioridade):**
1. PerformanceSettings (configurado pelo usuário — sempre preferido)
2. AutopilotConfig (legado, usado apenas se PerformanceSettings não existir)
3. Valores padrão do sistema (hard-coded no motor)

**Regra crítica sobre zeros:** Um campo zerado (0) em PerformanceSettings significa **"meta não configurada — não aplicar esta regra"**. O motor NÃO usa fallback quando você zera um campo. Isso é diferente de deixar vazio.

**Quando salvar metas:** Ao salvar, o motor determinístico é disparado imediatamente para aplicar as novas metas em tempo real. Não é necessário aguardar o próximo ciclo.`
      },
      {
        title: 'Campos Principais e seus Efeitos',
        content: `**Metas financeiras:**
- \`target_acos\` — ACoS alvo (%). Se 0, o motor não avalia ACoS para escala
- \`max_acos\` — ACoS máximo econômico (%). Se 0, não bloqueia por ACoS alto
- \`target_roas\` — ROAS alvo. Se 0, não avalia ROAS
- \`target_tacos\` — TACoS alvo. Se 0, não avalia TACoS
- \`daily_budget_limit\` — Limite real de gasto diário em R$ (guardrail de orçamento)

**Controles de bid:**
- \`min_bid\` / \`max_bid\` — Piso e teto absolutos de lance (padrão: R$0,40 / R$1,00)
- \`max_bid_increase_pct\` — % máximo de aumento por ciclo (padrão: 15%)
- \`max_bid_decrease_pct\` — % máximo de redução por ciclo (padrão: 20%)
- \`max_cpc\` — CPC máximo seguro global (substituído por safe_max_cpc por produto quando disponível)

**Parâmetros de qualidade de dados (MRC):**
- \`cvr_min_clicks_for_trust\` — Cliques mínimos para confiar na CVR observada (padrão: 10)
- \`fallback_conversion_rate\` — CVR padrão quando não há dados suficientes (padrão: 5%)
- \`initial_bid_amazon_pct\` — % da sugestão Amazon para bid inicial em novos produtos (padrão: 55%)`
      },
      {
        title: 'Metas de ACoS por Estágio de Aprendizado',
        content: `Para produtos em aprendizado, o motor usa metas de ACoS específicas por estágio em vez da meta global:

| Campo | Estágio | Comportamento se 0 |
|---|---|---|
| \`acos_learning_stages\` | initial_learning + bid_discovery | Usa break_even_acos do produto |
| \`acos_collection_stage\` | term_collection | Usa break_even_acos |
| \`acos_growth_stage\` | early_growth | Usa 90% do break_even |
| \`acos_mature_stage\` | mature | Usa 80% do break_even |
| \`acos_recovery_stage\` | declining | Usa 70% do break_even |

**Safety factors por estágio:** Controlam o quão conservador é o bid em cada fase.
- \`safety_factor_initial_learning\` = 0,80 (80% do bid máximo calculado)
- \`safety_factor_mature\` = 0,95 (quase no limite)
- \`safety_factor_declining\` = 0,75 (conservador)`
      }
    ]
  },
  {
    id: 'motor-deterministico',
    icon: Cpu,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
    title: 'Motor Estratégico v4 (Módulo B)',
    subsections: [
      {
        title: 'Filosofia do Motor v4',
        content: `O motor v4 não apenas reduz ACoS — ele **maximiza lucro incremental sustentável**.

**Objetivo:** Atrair o comprador certo → para o produto certo → com a intenção certa → no custo economicamente sustentável → mantendo margem e estoque.

**Três pilares de decisão:**
1. **Intenção de busca:** classificação semântica de cada keyword (transacional, informacional, cauda longa, etc.)
2. **Metas econômicas dinâmicas por produto:** break_even_acos = margem bruta do produto; target_acos = break_even × safety_factor
3. **Gap ACoS Real vs ACoS Alvo:** cada decisão inclui o delta entre o ACoS atual e a meta, orientando escala ou redução

**Metodologia MRC (Media Rating Council):**
- Cliques mínimos: 10 | Impressões mínimas: 200 | Gasto mínimo: R$12
- Janela primária de dados: 14 dias
- Múltiplas janelas: 3d, 7d, 14d, 30d — decisão nunca por janela isolada
- Dados stale > 48h bloqueiam aumentos de bid automaticamente`
      },
      {
        title: 'Hierarquia de Prioridade de Decisões',
        content: `O motor resolve conflitos por esta hierarquia (menor número = maior prioridade):

| Prioridade | Camada | Descrição |
|---|---|---|
| 1 | Segurança da conta | Token, autenticação, erros de API |
| 2 | Qualidade dos dados | Sync > 48h bloqueia aumentos |
| 3 | Estoque | Zero = bid mínimo; crítico (<7d) = redução imediata |
| 4 | Disponibilidade da oferta | Produto ativo, buybox, fba_inventory |
| 5 | Margem | break_even por produto, safe_max_cpc |
| 6 | Orçamento global | Guardrail de gasto real diário (D-1) |
| 7 | Proteção de alta performance | Vencedores consistentes não são pausados |
| 8 | Redução de desperdício | Sem conversão → reduzir ou pausar |
| 9 | Manutenção | Ajustes finos de bid |
| 10 | Escala | ACoS abaixo da meta + intenção alta |
| 11 | Expansão | Novos termos, novos clusters semânticos |
| 12 | Criação de campanhas | Confiança ≥ 95%, relevância ≥ 95% |

**Proteção de alta performance:** Keywords com ACoS ≤ meta em 14d e 30d, ROAS acima do alvo e ≥2 pedidos/14d são protegidas contra pausas e recebem apenas aumentos suaves.`
      },
      {
        title: 'Metas Econômicas Dinâmicas por Produto',
        content: `O motor calcula automaticamente a meta ideal de cada produto baseado nos seus custos reais:

**Fórmulas:**
- \`break_even_acos\` = margem bruta do produto (%)
- \`target_acos_asin\` = break_even_acos × safety_factor (padrão 80%)
- \`safe_max_cpc\` = preço_venda × margem_bruta × safety_factor × cvr_estimada

**Exemplo prático:**
Produto: R$89,90 · Margem: 32% · CVR: 5%
→ break_even_acos = 32%
→ target_acos = 32% × 0,80 = 25,6%
→ safe_max_cpc = 89,90 × 0,32 × 0,80 × 0,05 = R$1,15

**Bloqueios por margem:**
- Margem negativa → bloqueia expansão e novos bids
- Estoque zero → bid reduzido ao mínimo configurado
- Ads eligibility = 'blocked' → nenhuma decisão de bid gerada`
      },
      {
        title: 'Classificação de Intenção de Busca',
        content: `Cada keyword é classificada semanticamente. A intenção influencia o tamanho dos ajustes:

| Intenção | Exemplos | Purchase Intent | Bônus de Escala |
|---|---|---|---|
| Cauda longa | "lixeira 10l inox sensor banheiro" | Alta (0,95) | 100% do máximo |
| Comercial | "lixeira com sensor" | Alta (0,88) | 100% |
| Benefício | "lixeira automática touch" | Média-alta (0,82) | 75% |
| Categoria | "lixeira" | Baixa (0,35) | 50% |
| Informacional | "como escolher lixeira" | Baixa (0,20) | 0% — pause sugerido |

**Bônus de tendência:** Se a campanha mostra crescimento de vendas nos últimos 3 dias vs 14 dias (+10%), o aumento de bid recebe multiplicador de 1,15×.

**Pausa automática:** Keywords com intenção informacional E gasto > R$24 sem conversão recebem sugestão de pausa.`
      },
      {
        title: 'Guardrails Financeiros (não configuráveis)',
        content: `Estes limites são hard-coded no motor e nunca são ultrapassados:

- **Bid mínimo absoluto:** R$0,10 (sobrepõe qualquer configuração)
- **Variação máxima por ciclo:** limitada por max_bid_increase_pct e max_bid_decrease_pct
- **Bloqueio de dados stale:** Motor não aumenta bids se dados > 48h
- **Guardrail de orçamento:** Se gasto real D-1 > daily_budget_limit, aumentos de bid são bloqueados
- **Cooldown de decisão:** Mínimo de 72h entre ações na mesma keyword
- **Evidência mínima MRC:** ≥10 cliques, ≥200 impressões, ≥R$12 antes de qualquer decisão`
      }
    ]
  },
  {
    id: 'intencao-busca',
    icon: Search,
    color: 'text-pink-400',
    bg: 'bg-pink-500/10 border-pink-500/20',
    title: 'Intenção de Busca e Clusters Semânticos',
    subsections: [
      {
        title: 'Como funciona a classificação semântica',
        content: `O motor analisa cada keyword e identifica sinais linguísticos para determinar a intenção do comprador:

**Sinais de alta intenção transacional:**
- Termos de tamanho: "10l", "litros", "metro", "cm", "grande", "mini"
- Termos de material: "inox", "aço", "plástico", "alumínio", "silicone"
- Termos de problema: "antiodor", "sem ruído", "vedado", "hermético"
- Termos de benefício: "automático", "sensor", "inteligente", "smart", "recarregável"
- Termos de localização: "banheiro", "cozinha", "escritório", "pet", "externo"

**Sinais de baixa intenção (informacional):**
- Prefixos: "como", "o que é", "qual", "quando", "por que"
- Sufixos: "tutorial", "dica", "review", "avaliação", "comparação"

**Regra da cauda longa:** Keywords com 3+ palavras + pelo menos 1 qualificador (tamanho, material, benefício, localização) = alta intenção de compra (score ≥ 0,88).`
      },
      {
        title: 'Clusters Semânticos e Estratégia',
        content: `O motor agrupa keywords em clusters para análise estratégica:

| Cluster | Tipo | Estratégia |
|---|---|---|
| \`tamanho\` | "lixeira 10 litros" | Escala agressiva se ACoS ok |
| \`material\` | "lixeira inox" | Escala moderada |
| \`beneficio\` | "lixeira automática sensor" | Escala com bônus de tendência |
| \`problema\` | "lixeira antiodor" | Alta prioridade — intenção clara |
| \`uso\` | "lixeira para banheiro" | Escala se match de produto |
| \`cauda_longa\` | "lixeira 10l inox sensor toque" | Máxima prioridade de escala |
| \`informacional\` | "como escolher lixeira" | Redução ou pausa |
| \`comparacao\` | "lixeira sensor vs pedal" | Manutenção conservadora |

O cluster de cada keyword aparece no rationale de cada decisão gerada.`
      }
    ]
  },
  {
    id: 'acos-comparacao',
    icon: BarChart2,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/20',
    title: 'ACoS Real vs ACoS Alvo',
    subsections: [
      {
        title: 'Gap de ACoS no Motor de Decisão',
        content: `Cada decisão gerada pelo motor inclui o **gap entre ACoS real e ACoS alvo** nos metadados:

\`gap_pct = real_acos_14d - target_acos\`

- **gap positivo:** ACoS acima da meta → motor reduz bids
- **gap negativo:** ACoS abaixo da meta → motor considera escala

**Status por campanha:**
- \`below_target\`: ACoS ≤ 75% da meta → escala autorizada
- \`on_target\`: ACoS entre 75% e 105% da meta → manutenção
- \`above_target\`: ACoS entre 105% e 150% da meta → redução suave
- \`critical\`: ACoS > 150% da meta → redução máxima imediata

**Visão agregada:** O motor calcula e registra nas respostas:
- Campanhas abaixo/na/acima da meta
- Top 5 campanhas piores (maior gap positivo com gasto > R$5)
- Top 5 campanhas melhores (maior gap negativo com pedidos)

Esses dados são visíveis na Sala de Comando > Estratégias após executar o motor.`
      },
      {
        title: 'ACoS por Janela de Tempo',
        content: `O motor nunca decide por uma única janela de tempo. Ele usa múltiplas janelas:

| Janela | Uso principal |
|---|---|
| 3 dias | Detectar tendências recentes (spike ou queda) |
| 7 dias | Validar padrão de semana |
| 14 dias | Janela primária MRC — base para decisão |
| 30 dias | Contexto histórico e sazonalidade |

**Tendência 3d vs 14d:** Se as vendas dos últimos 3 dias estão 10% acima da média diária dos últimos 14 dias, o motor aplica um bônus de 1,15× no aumento de bid.

**Quando o motor aguarda mais dados:** Se uma keyword tem cliques < 10 ou impressões < 200 na janela de 14d, o motor registra como "held — insufficient data" e não aplica nenhuma regra, apenas calibra o bid para gerar mais impressões se necessário.`
      }
    ]
  },
  {
    id: 'termbank',
    icon: Layers,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10 border-violet-500/20',
    title: 'Banco de Termos (TermBank)',
    subsections: [
      {
        title: 'Fontes e Ciclo de Vida de um Termo',
        content: `O TermBank é o repositório central de palavras-chave. Alimenta kickoffs e promoção de termos vencedores.

**Fontes de termos:**
1. \`search_term_auto\` — Importados de campanhas AUTO (≥3 pedidos/30d)
2. \`ai_suggestion\` — Sugeridos pela IA ao analisar título do produto
3. \`user_input\` — Inseridos manualmente pelo usuário
4. \`deterministic_title_parser\` — Extraídos do título por parser determinístico

**Ciclo de vida:**
\`new\` → \`learning\` → \`winner\` (≥2 conversões, ACoS < break_even) → promovido para campanha manual EXACT

**Critérios de promoção automática (semanal):**
- ≥2 conversões confirmadas
- Não está ainda em campanha manual exact
- Produto com estoque positivo (fba_inventory > 0)
- Intenção de busca ≠ informational`
      },
      {
        title: 'Promoção de Termos Vencedores',
        content: `**O que acontece ao promover um termo:**
1. Cria campanha manual exact com nome: \`EXACT | {ASIN} | {term}\`
2. Adiciona o termo como negativo na campanha AUTO de origem
3. Registra em SearchTermPromotion com status = promoted_to_manual
4. Atualiza TermBank com promotion_status = promoted_to_manual
5. Bid inicial = CPC histórico do termo × 1,1 (nunca abaixo do min_bid)

**Frequência:** Toda semana via runWeeklySearchTermPromotion.

**Negativação automática (weekly waste cleanup):**
Termos no AUTO com gasto > R$5 E zero conversões nos últimos 30 dias são negativados automaticamente toda sexta-feira. Isso evita desperdício crônico de orçamento.`
      }
    ]
  },
  {
    id: 'campanhas',
    icon: Target,
    color: 'text-cyan',
    bg: 'bg-cyan/10 border-cyan/20',
    title: 'Gestão de Campanhas',
    subsections: [
      {
        title: 'Estrutura Padrão de Campanhas',
        content: `Cada produto ativo segue a estrutura de duas campanhas complementares:

**AUTO (Descoberta):**
Nome: \`AUTO | {ASIN} | {data}\`
Targeting: AUTO (Amazon define targeting automaticamente)
Objetivo: descobrir novos termos vencedores, gerar dados

**MANUAL EXACT (Conversão):**
Nome: \`EXACT | {ASIN} | {keyword}\`
Targeting: MANUAL, match EXACT
Bid inicial: CPC histórico do termo no AUTO × 1,1
Objetivo: converter tráfego qualificado com máximo controle de custo

**Regra de não canibalização:** Quando um termo é promovido para EXACT, é negativado imediatamente no AUTO. Sem negativação automática, as duas campanhas competem leilão a leilão, elevando o CPC desnecessariamente.`
      },
      {
        title: 'Kickoff de Produto Novo',
        content: `Ao ativar o kickoff de um produto, o sistema executa:

1. Busca sugestões de keywords com confiança ≥ 95% (máx. 10 por ASIN)
2. Cria campanha AUTO com bid inicial = sugestão Amazon × initial_bid_amazon_pct (55%)
3. Agenda criação de campanhas EXACT para os termos aprovados
4. Registra em ProductKickoffQueue (status = scheduled)

**Modos de kickoff:**
- \`auto_plus_four\` — 1 campanha AUTO + até 4 manuais EXACT (recomendado para produto novo)
- \`manual_only\` — Apenas campanhas manuais para termos já confirmados (produto com histórico)

**Produtos sem estoque:** O kickoff é bloqueado automaticamente quando fba_inventory = 0. O status aparece como "Aguardando Estoque" no painel de kickoff.

**Acelerador 48h:** Para produtos em lançamento urgente, bids são elevados temporariamente para garantir impressões nas primeiras 48h.`
      },
      {
        title: 'Reparos Automáticos de Campanhas',
        content: `O sistema verifica e repara automaticamente campanas com problemas estruturais:

**Campanhas INCOMPLETE:**
Criadas sem product ads ou ad groups válidos. Detectadas e reparadas em até 24h via processAutoCampaignRepairQueueV2.

**Keywords com lance zero:**
Keywords com bid = 0 ou inválido são corrigidas com CPC histórico médio da campanha.

**Campanhas com produto sem estoque:**
fba_inventory = 0 → product ads pausados, bids reduzidos ao min_bid.

**Campanhas arquivadas:**
Campaigns com state = ARCHIVED são **ignoradas em toda a aplicação** (importação, dashboard, motor, interface). O sistema foca apenas em ENABLED, PAUSED e INCOMPLETE.`
      }
    ]
  },
  {
    id: 'sincronizacao',
    icon: RefreshCw,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    title: 'Sincronização de Dados',
    subsections: [
      {
        title: 'Fluxo de Sincronização',
        content: `**Fase 1 — Importação de campanhas (syncAdsCampaignStatesV2):**
Busca via Amazon Ads API todas as campanhas ENABLED/PAUSED/INCOMPLETE. Atualiza entidade Campaign.

**Fase 2 — Relatório de métricas (requestAmazonAdsReportV3 + downloadAndProcessAmazonAdsReportJob):**
Solicita relatório de métricas diárias por campanha. Amazon processa em 2–10 minutos. Ao finalizar, métricas são gravadas em CampaignMetricsDaily.

**Fase 3 — Inventário FBA (syncProductsFromInventory):**
Busca estoque atual via SP-API. Atualiza fba_inventory em Product. Dispara kickoff para produtos reabastecidos.

**Fase 4 — Vendas reais (syncProductSalesMetrics):**
Importa vendas por ASIN de SalesDaily. Usado para cálculo de TACoS real e velocidade de vendas.

**Tolerância de dados desatualizados:**
- < 24h: status OK
- 24h–48h: banner de alerta (stale) no dashboard
- > 48h: motor bloqueia aumentos de bid automaticamente`
      },
      {
        title: 'Token OAuth e Autenticação',
        content: `**Amazon Ads API:**
OAuth2 LWA (Login with Amazon). O refresh token é persistido na entidade AmazonAccount. O access token é gerado automaticamente e cacheado por 55 minutos.

**Renovação automática do token:**
A função refreshAmazonAdsTokenDailyOrHourly roda a cada 30 minutos para manter o token sempre válido, evitando falhas em pipelinebs agendados.

**SP-API:**
Usa refresh token independente (SP_REFRESH_TOKEN). Autenticação via client credentials próprios.

**Sinais de problema de autenticação:**
- Banner vermelho "Token inválido" no dashboard
- Erros HTTP 401/403 nos logs de SyncExecutionLog
- ads_token_status = 'revoked' ou 'error' na entidade AmazonAccount

**Como reautorizar:**
Ir para /integracoes/amazon ou /amazon-oauth-setup → clicar "Conectar Amazon Ads" → fazer login na Amazon → autorizar o app → token salvo automaticamente.`
      }
    ]
  },
  {
    id: 'analytics',
    icon: BarChart2,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/20',
    title: 'Analytics e Métricas',
    subsections: [
      {
        title: 'Métricas-chave e Definições',
        content: `**ACoS (Advertising Cost of Sales):**
\`gasto_ads / vendas_atribuídas × 100\`
Mede eficiência do anúncio. Target padrão: configurado em PerformanceSettings. Máximo econômico = break_even_acos do produto.

**TACoS (Total Advertising Cost of Sales):**
\`gasto_ads / faturamento_real × 100\`
Mede impacto dos ads no negócio total. Usa dados de SP-API, não vendas atribuídas. Mais representativo para saúde geral.

**break_even_acos:**
\`margem_bruta_% do produto\`
O ponto onde cada R$1 de gasto em ads ainda gera lucro zero. Acima disso = prejuízo incremental.

**safe_max_cpc:**
\`preço × margem × safety_factor × CVR\`
CPC máximo que ainda permite lucro após deduzir todos os custos. Calculado automaticamente por produto.

**ROAS (Return on Ad Spend):**
\`vendas_atribuídas / gasto_ads\`
Meta configurável em PerformanceSettings.

**CVR (Conversion Rate):**
\`pedidos / cliques\`
Usado para calcular safe_max_cpc. Mínimo de 10 cliques para ser confiável (configurável em cvr_min_clicks_for_trust).`
      },
      {
        title: 'Dashboard — Períodos e Fontes de Dados',
        content: `**Período no Dashboard:**
O dashboard usa dados fechados (sem o dia atual). "Ontem" significa o dia anterior completo em timezone BRT (UTC-3).

**Gasto D-1 (ontem):**
Soma deduplificada de spend por campaign_id para a data de ontem em BRT. Se parecer incorreto, o subtexto mostra a data exata e a quantidade de registros para diagnóstico.

**Faturamento Real vs Vendas Ads:**
- "Vendas Ads" = atribuição Amazon (janela de 14 dias, pode inflar o número)
- "Faturamento Real" = SP-API ordered_product_sales (o que realmente foi pago)
Os dois números são diferentes por design. Use Faturamento Real para decisões financeiras.

**Deduplicação de campanhas:**
Registros duplicados pelo mesmo campaign_id são deduplicados priorizando o com maior spend.

**Latência da Amazon:**
Dados de campanhas têm latência natural de 1–2 dias. O dashboard aceita gaps de até 3 dias antes de marcar como desatualizado.`
      }
    ]
  },
  {
    id: 'resolucao-problemas',
    icon: AlertTriangle,
    color: 'text-red-400',
    bg: 'bg-red-500/10 border-red-500/20',
    title: 'Resolução de Problemas',
    subsections: [
      {
        title: 'Motor não gera decisões',
        content: `**Verificar em ordem:**

1. **Dados stale:** data_age_hours > 48h no resultado do motor → execute sync primeiro
2. **Cooldown ativo:** A mesma keyword só recebe ação após 72h do último ajuste
3. **Evidência insuficiente:** Keyword com < 10 cliques ou < 200 impressões → motor aguarda mais dados
4. **Metas zeradas:** Se target_acos = 0 E max_acos = 0, o motor não avalia ACoS por design
5. **Produto sem estoque:** fba_inventory = 0 → motor gera apenas ação de bid mínimo
6. **Token OAuth expirado:** Verificar ads_token_status na entidade AmazonAccount

**Diagnóstico rápido:** Sala de Comando > Estratégias > "Executar Motor" → ver o resultado JSON com stats detalhados.`
      },
      {
        title: 'Gasto D-1 aparece incorreto',
        content: `O "Gasto D-1" mostra o gasto real de ontem em BRT (UTC-3). Possíveis causas de valor estranho:

**Valor muito alto (>100% do limite):**
- Limite diário configurado muito baixo em PerformanceSettings.daily_budget_limit
- O limite em PerformanceSettings é um GUARDRAIL de risco, não uma restrição rígida das campanhas na Amazon. As campanhas individuais têm seus próprios orçamentos na Amazon.
- Verifique o valor real do limite em Configurações > Metas de Performance

**Valor zero quando há campanhas ativas:**
- Sync de ontem ainda não concluiu (latência Amazon de 1–2 dias)
- Verificar última data disponível nos dados de CampaignMetricsDaily

**Diagnóstico:** O card mostra "(YYYY-MM-DD) · X registros" para confirmar a data e quantidade de registros usados no cálculo.`
      },
      {
        title: 'Campanhas não aparecem no Dashboard',
        content: `**Causas mais comuns:**

1. **Campanhas ARCHIVED:** Ignoradas por design em todo o sistema. Foco em ENABLED, PAUSED, INCOMPLETE.

2. **Deduplicação:** Múltiplos registros para o mesmo campaign_id são deduplicados pelo maior spend. Se uma campanha "sumiu", pode ter sido substituída por um registro mais recente.

3. **Sync não executou:** Verificar SyncExecutionLog para erros recentes.

4. **Campanha INCOMPLETE:** Aparece na seção de Campanhas Incompletas mas pode não ter métricas no gráfico ainda.

5. **Token revogado:** Se o sync falha com 401, nenhuma campanha nova é importada. Reautorizar em /integracoes/amazon.`
      },
      {
        title: 'Sala de Comando — Monitoramento Operacional',
        content: `A página /sala-de-comando centraliza todos os logs e filas:

**Aba Alertas:** Gerados por checkAndCreateAlerts — ACoS alto, gasto anormal, estoque crítico, token expirado.

**Aba Estratégias:** Motor estratégico v4 — decisões, visão por produto, distribuição de intenção de busca, metas vs realidade.

**Aba Prelação Semanal:** Relatório do Módulo A (IA semanal) com análise de performance e regras propostas.

**Log de Bids (/bid-logs):** Histórico completo de ajustes automáticos com gráfico de evolução de bids × resultado (impressões/cliques/ACoS real).

**Kickoff Monitor (/kickoff-monitor):** Produtos na fila de criação de campanhas, com status por etapa e possibilidade de cancelamento.`
      }
    ]
  },
  {
    id: 'fluxos-chave',
    icon: GitBranch,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    title: 'Fluxos Operacionais Chave',
    subsections: [
      {
        title: 'Fluxo: Produto Novo → Primeiras Vendas',
        content: `\`\`\`
Produto entra no FBA com estoque > 0
        ↓
checkInventoryChangesAndKickoff (diário 10h UTC)
  → Detecta produto novo ou reabastecido
  → processNewOrRestockedProductsForTermBank
    → Busca sugestões Amazon + título do produto
    → Salva em TermBank + KeywordSuggestion
        ↓
Usuário aprova sugestões no TermBank
  → reviewKeywordSuggestion
  → createManualCampaignV2 → Campanha EXACT criada na Amazon
        ↓
Kickoff AUTO (scheduleProductKickoff)
  → processProductKickoffQueueV2
  → createAutoCampaignForAsinSafe → Campanha AUTO criada
        ↓
Motor diário (cada hora):
  → Regras de estoque ajustam bids por cobertura
  → Intenção de busca classifica cada keyword
  → Gap ACoS orienta escala ou redução
  → Harvest: termos com ≥2 conversões → promovidos para EXACT
  → Waste cleanup: termos sem conversão → negativados
\`\`\``
      },
      {
        title: 'Fluxo: Decisão de Bid → Execução na Amazon',
        content: `\`\`\`
runDeterministicDecisionEngine (motor v4)
  → Carrega PerformanceSettings (fonte única)
  → Calcula metas econômicas dinâmicas por produto
  → Classifica intenção de busca de cada keyword
  → Avalia gap ACoS real vs ACoS alvo por campanha
  → Aplica hierarquia de prioridade (12 camadas)
  → Gera OptimizationDecision (status = approved)
        ↓
executeApprovedDecisionQueue (cada hora)
  → Lê OptimizationDecision com status = approved
  → PUT /keywords/{id} na Amazon Ads API
  → Atualiza status → executed
  → Cria registro em AdsBidChangeLog:
      old_bid, new_bid, rationale, gap_acos, intent_type
        ↓
Resultado visível em:
  → /bid-logs (histórico + gráfico de evolução)
  → /sala-de-comando > Estratégias (decisões)
\`\`\``
      },
      {
        title: 'Fluxo: Salvar Metas → Motor em Tempo Real',
        content: `\`\`\`
Usuário edita Metas de Performance em /settings
  → Clica "Salvar"
        ↓
Settings.jsx dispara imediatamente:
  → invoke('runUnifiedDecisionEngine') → motor v4 executa
  → Cria OptimizationDecision para reload
        ↓
Motor v4 recalcula com as novas metas:
  → Novos targets de ACoS → novas decisões de bid
  → Novos safe_max_cpc → ajustes de bid por produto
  → Guardrail de orçamento com novo daily_budget_limit
        ↓
Fila de execução (próximos minutos):
  → executeApprovedDecisionQueue aplica as decisões na Amazon
\`\`\`

**Isso significa:** qualquer mudança nas metas tem efeito real nas campanhas em até 1 hora.`
      }
    ]
  }
];

function ContentBlock({ content }) {
  const lines = content.split('\n');
  let inCode = false;
  const codeLines = [];

  return (
    <div className="space-y-1.5 text-sm text-slate-300 leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith('```')) {
          inCode = !inCode;
          if (!inCode && codeLines.length > 0) {
            const block = codeLines.splice(0);
            return (
              <pre key={i} className="bg-surface-3/60 border border-surface-3 rounded-lg p-3 text-[11px] font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap leading-5">
                {block.join('\n')}
              </pre>
            );
          }
          return null;
        }
        if (inCode) { codeLines.push(line); return null; }

        if (line.startsWith('| ') && line.endsWith(' |')) {
          const cells = line.split('|').filter(c => c.trim() !== '');
          const isHeader = lines[i + 1]?.startsWith('|---');
          if (line.includes('---')) return null;
          return (
            <div key={i} className={`grid gap-2 text-xs py-1.5 border-b border-surface-2/40 last:border-0 ${cells.length === 2 ? 'grid-cols-2' : cells.length === 3 ? 'grid-cols-3' : 'grid-cols-4'} ${isHeader ? 'text-slate-500 border-b border-surface-2 pb-2' : ''}`}>
              {cells.map((c, j) => (
                <span key={j} className={isHeader ? 'font-semibold uppercase tracking-wide text-[10px] text-slate-400' : 'text-slate-300'}>
                  {c.trim().replace(/`/g, '')}
                </span>
              ))}
            </div>
          );
        }

        if (line.startsWith('- ') || line.startsWith('→ ')) {
          const text = line.slice(2);
          const parts = text.split(/`([^`]+)`/);
          return (
            <p key={i} className="flex gap-2 text-sm">
              <span className="text-slate-500 flex-shrink-0 mt-0.5 select-none">{line[0] === '-' ? '•' : '→'}</span>
              <span>
                {parts.map((p, j) => j % 2 === 0
                  ? p.replace(/\*\*([^*]+)\*\*/g, (_, m) => m) // strip bold for inline rendering
                  : <code key={j} className="bg-surface-2 px-1 py-0.5 rounded text-cyan text-[11px] font-mono">{p}</code>
                )}
              </span>
            </p>
          );
        }

        if (line.trim() === '') return <div key={i} className="h-1.5" />;

        const renderInline = (str) => {
          const parts = str.split(/`([^`]+)`/);
          return parts.map((p, j) => {
            if (j % 2 !== 0) return <code key={j} className="bg-surface-2 px-1 py-0.5 rounded text-cyan text-[11px] font-mono">{p}</code>;
            const bparts = p.split(/\*\*([^*]+)\*\*/);
            return bparts.map((b, k) => k % 2 === 0 ? b : <strong key={k} className="text-white font-semibold">{b}</strong>);
          });
        };

        return <p key={i} className="text-sm">{renderInline(line)}</p>;
      })}
    </div>
  );
}

export default function ManualInstrucoes() {
  const [openSection, setOpenSection] = useState('visao-geral');
  const [openSubsections, setOpenSubsections] = useState({});

  const toggleSection = (id) => setOpenSection(prev => prev === id ? null : id);
  const toggleSubsection = (key) => setOpenSubsections(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="max-w-4xl mx-auto space-y-5 p-6 animate-fade-in">

      {/* Header */}
      <div className="rounded-2xl border border-cyan/20 bg-cyan/5 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <BookOpen className="h-6 w-6 text-cyan" />
              <h1 className="text-xl font-bold text-white">Manual — LivingFinds</h1>
            </div>
            <p className="text-sm text-slate-400">Referência completa da plataforma de gestão autônoma de anúncios Amazon</p>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-3 py-1">
              <Star className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-xs font-bold text-emerald-300">v{VERSION}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">{VERSION_DATE}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {[
            { icon: Cpu, label: 'Motor Estratégico v4', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
            { icon: Target, label: 'PerformanceSettings — Fonte Única', color: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
            { icon: Search, label: 'Intenção de Busca Semântica', color: 'text-pink-400 bg-pink-500/10 border-pink-500/20' },
            { icon: ShieldCheck, label: 'Guardrails MRC', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
            { icon: Clock, label: 'Pipeline Horário', color: 'text-cyan bg-cyan/10 border-cyan/20' },
          ].map(({ icon: Icon, label, color }) => (
            <span key={label} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${color}`}>
              <Icon className="h-3 w-3" />{label}
            </span>
          ))}
        </div>
      </div>

      {/* Índice */}
      <div className="rounded-xl border border-surface-2 bg-surface-1 p-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Índice</p>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return (
              <button key={s.id}
                onClick={() => { setOpenSection(s.id); setTimeout(() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-surface-2 transition-colors text-left">
                <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${s.color}`} />
                <span className="truncate">{s.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Seções */}
      {SECTIONS.map(section => {
        const isOpen = openSection === section.id;
        const Icon = section.icon;
        return (
          <div key={section.id} id={section.id} className="space-y-2">
            <button
              onClick={() => toggleSection(section.id)}
              className={`w-full flex items-center justify-between px-5 py-4 rounded-xl border transition-all ${section.bg} ${isOpen ? 'ring-1 ring-white/10' : 'hover:bg-white/5'}`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`h-5 w-5 flex-shrink-0 ${section.color}`} />
                <span className="font-semibold text-white text-sm">{section.title}</span>
              </div>
              {isOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
            </button>

            {isOpen && (
              <div className="ml-2 space-y-2">
                {section.subsections.map((sub, si) => {
                  const key = `${section.id}-${si}`;
                  const subOpen = openSubsections[key] !== false;
                  return (
                    <div key={key} className="rounded-xl border border-surface-2 bg-surface-1 overflow-hidden">
                      <button
                        onClick={() => toggleSubsection(key)}
                        className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-2/50 transition-colors"
                      >
                        <span className="text-sm font-medium text-white text-left">{sub.title}</span>
                        {subOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" />}
                      </button>
                      {subOpen && (
                        <div className="px-5 pb-5 border-t border-surface-2 pt-4">
                          <ContentBlock content={sub.content} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer */}
      <div className="rounded-xl border border-surface-2 bg-surface-1 px-5 py-4 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
          <span>Versão <strong className="text-white">v{VERSION}</strong> — Atualizado em {VERSION_DATE} · Motor Estratégico v4</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Clock className="h-3 w-3" />
          Pipeline: a cada hora
        </div>
      </div>
    </div>
  );
}