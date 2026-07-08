import { useState } from 'react';
import {
  BookOpen, ChevronDown, ChevronRight, Zap, Brain, Target, TrendingUp,
  ShieldCheck, BarChart2, RefreshCw, AlertTriangle, CheckCircle, Clock,
  Settings, Layers, ArrowRight, Info, Star, Package, DollarSign, Activity
} from 'lucide-react';

const VERSION = '1.0.0';
const VERSION_DATE = '08/07/2026';

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
        content: `O LivingFinds é uma plataforma de gestão autônoma de anúncios Amazon, construída sobre dois módulos independentes que rodam em paralelo todos os dias:

**Módulo A — IA Semanal (Claude):** Analisa performance histórica de 30 dias, gera regras estratégicas de longo prazo e as submete para aprovação antes de ativar. Roda toda segunda-feira.

**Módulo B — Motor Determinístico Diário:** Executa decisões de bid em tempo real baseadas em regras matemáticas auditáveis — sem IA. Roda todo dia às 09:00 UTC com o pipeline completo.

Os dois módulos NUNCA interferem diretamente um no outro. O Módulo A gera regras → passam por validação → são ativadas → o Módulo B as executa.`
      },
      {
        title: 'Arquitetura de Automações (Pipeline Diário)',
        content: `O ciclo diário automático segue esta sequência:

**09:00 UTC — runDailyFullReportPipeline**
Sincroniza campanhas, inventário e métricas da Amazon Ads API + SP-API.

**09:30 UTC — runFullAccountOptimizationWithNewLogic**
1. Contexto de qualidade de dados
2. Redução de bids por economia (ECONOMY_FIRST)
3. Revisão de estrutura de campanhas (keywords, product ads, integridade)
4. Motor determinístico (regras de estoque + ACoS + regras do banco)
5. Avaliação de outcomes de decisões anteriores

**10:00 UTC — Guardrails horários (runHourlyAdsGuardrails)**
Roda a cada hora: protege contra spikes de gasto, pausa campanhas com produto sem estoque, monitora ações travadas.

**Segunda-feira 08:00 UTC — runWeeklyClaudeRuleReview**
Módulo A: análise profunda com Claude, geração de regras, backtest histórico, submissão para aprovação.

**Sexta-feira 22:00 UTC — runWeeklyWasteTermsCleanup**
Negativação automática de termos sem conversão que gastaram > R$5.

**Sábado 10:00 UTC — updateTermBankFromAutomaticCampaigns**
Importa termos vencedores (≥3 pedidos/30d) das campanhas AUTO para o TermBank.`
      }
    ]
  },
  {
    id: 'motor-deterministico',
    icon: Zap,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
    title: 'Motor Determinístico (Módulo B)',
    subsections: [
      {
        title: 'Regras Nativas de Estoque (Prioridade Máxima)',
        content: `O motor avalia o estoque de cada ASIN ANTES de qualquer outra regra. São 5 níveis:

| Cobertura de Estoque | Ação | Cooldown |
|---|---|---|
| 0 unidades | Bid → R$0,10 (mínimo) | 24h |
| < 7 dias | Bid -25% | 48h |
| 7–21 dias | Bid -10% | 48h |
| 21–60 dias | Nenhuma ação | — |
| 60–90 dias | Bid +10% | 48h |
| > 90 dias | Bid +15% (liquidação) | 48h |

**Cobertura** = estoque atual ÷ velocidade de vendas (unidades/dia nos últimos 30d).
Boosts de estoque são bloqueados em dias de baixa demanda, feriados sem vendas e se o produto não tem histórico de venda real.`
      },
      {
        title: 'Regras Nativas de ACoS por ASIN (30 dias)',
        content: `Após as regras de estoque, o motor avalia o ACoS real de cada ASIN comparado com o target_acos configurado no AutopilotConfig (padrão: 10%).

**Requisitos mínimos:** ≥10 cliques E ≥R$5 de gasto nos últimos 30 dias.

| Situação | Ação | Cooldown |
|---|---|---|
| ACoS real > meta +50% | Bid -15% | 72h |
| ACoS real > meta +20% a +50% | Bid -8% | 72h |
| Zona neutra (±20% da meta) | Sem ação | — |
| ACoS real < meta -30% | Bid +8% | 72h |

Boosts de ACoS são bloqueados em baixa demanda, sem estoque ou sem vendas reais.`
      },
      {
        title: 'Regras do Banco (DecisionRule)',
        content: `Após as regras nativas, o motor avalia as regras salvas na entidade DecisionRule (geradas pelo Módulo A ou criadas manualmente).

Cada regra tem:
- **scope:** keyword, campaign, product, account
- **conditions:** condições com operadores (greater_than, less_than, between, etc.)
- **action:** tipo e valor (increase_bid_percent, decrease_bid_percent, set_bid, etc.)
- **priority:** número menor = maior prioridade
- **cooldown_hours:** tempo mínimo entre execuções por entidade
- **status:** draft → validating → approved → active

Uma keyword não recebe mais de uma ação por ciclo. Em caso de conflito, a regra de maior prioridade vence.`
      },
      {
        title: 'Guardrails Financeiros (não configuráveis)',
        content: `Estes limites são codificados no motor e **não podem ser alterados** por configuração:

- **Bid mínimo:** R$ 0,10
- **Bid máximo:** R$ 5,00
- **Variação máxima por ciclo:** ±30% do bid atual
- **Budget total automático:** R$ 50–65/dia (referência — campanhas individuais têm budgets próprios)
- **Cooldown de dados:** Motor bloqueia automaticamente se dados têm mais de 48h sem sync
- **Contexto sazonal:** Boosts bloqueados em feriados, baixa demanda, finais de semana com histórico ruim`
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
        title: 'O que é o TermBank?',
        content: `O TermBank é o repositório central de palavras-chave da conta. Ele alimenta o kickoff de novas campanhas e o fluxo de promoção de termos vencedores.

**Fontes de termos:**
1. **search_term_auto:** Importados automaticamente de campanhas AUTO (termos com ≥3 pedidos/30d)
2. **ai_suggestion:** Sugeridos pela IA ao analisar título do produto
3. **user_input:** Inseridos manualmente pelo usuário
4. **deterministic_title_parser:** Extraídos do título do produto por parser determinístico

**Fluxo de vida de um termo:**
\`new\` → \`learning\` → \`winner\` (≥3 pedidos, ACoS < 60%) → promovido para campanha manual exact`
      },
      {
        title: 'Sugestões de IA (KeywordSuggestion)',
        content: `A IA gera sugestões para produtos sem termos suficientes no TermBank.

**Limites ativos:**
- Máximo **10 sugestões ativas** por ASIN
- Confiança mínima exibida: **75%**
- Sugestões com confiança < 75% são rejeitadas automaticamente
- Termos incompletos (< 3 caracteres, terminados em preposição) são filtrados

**Fluxo de aprovação:**
1. Clicar "Aprovar" → função reviewKeywordSuggestion cria campanha manual exact na Amazon
2. Clicar "Rejeitar" → termo removido da fila
3. "Aprovar Todas" → processa em sequência com pausa de 800ms entre chamadas

**Sincronização automática:** Ao abrir a página TermBank, os termos vencedores são importados automaticamente em background (sem intervenção do usuário).`
      },
      {
        title: 'Promoção de Termos Vencedores',
        content: `**Critérios para promoção automática (semanal):**
- ≥2 conversões confirmadas no período
- Não estar ainda em campanha manual exact
- Produto com estoque positivo

**O que acontece na promoção:**
1. Cria campanha manual exact com nome padronizado: \`EXACT | {ASIN} | {term}\`
2. Adiciona o termo como negativo na campanha AUTO de origem
3. Registra em SearchTermPromotion com status = promoted_to_manual
4. Atualiza TermBank com promotion_status = promoted_to_manual

**Frequência:** Todo sábado às 10:00 UTC via runWeeklySearchTermPromotion.`
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
        content: `Cada produto ativo segue a estrutura:

**AUTO (Descoberta):**
Nome: \`AUTO | {ASIN} | {data}\`
Targeting: AUTO (match de close variants, substitutes, complements, customers who buy)
Objetivo: descobrir novos termos vencedores

**MANUAL EXACT (Conversão):**
Nome: \`EXACT | {ASIN} | {keyword}\`
Targeting: MANUAL, match EXACT
Bid inicial: baseado no CPC histórico do termo no AUTO
Objetivo: converter tráfego qualificado ao menor custo

**Regra de negativação:** Quando um termo é promovido para EXACT, é negativado automaticamente no AUTO para evitar canibalização.`
      },
      {
        title: 'Kickoff de Produto Novo',
        content: `Ao ativar o kickoff de um produto, o sistema:

1. Gera termos iniciais via IA (máx. 10 por ASIN) com confiança ≥ 95%
2. Cria campanha AUTO com bid inicial de R$0,50
3. Agenda a criação de campanhas manuais para os termos aprovados
4. Registra em ProductKickoffQueue com status = scheduled

**Modos de kickoff:**
- **auto_plus_four:** 1 campanha AUTO + até 4 manuais exact
- **manual_only:** Somente campanhas manuais para termos já confirmados

**Acelerador (48h):** Para produtos em lançamento acelerado, bids são elevados temporariamente para garantir impressões.`
      },
      {
        title: 'Reparos Automáticos de Campanhas',
        content: `O sistema verifica e repara automaticamente:

**Campanhas INCOMPLETE:**
Campanhas criadas sem product ads ou ad groups válidos são detectadas e reparadas em até 24h.

**Keywords sem lances:**
Keywords com lance = 0 ou inválido são corrigidas com base no CPC histórico.

**Campanhas com produto sem estoque:**
Se fba_inventory = 0, os product ads são pausados e bids reduzidos ao mínimo.

**Campanhas duplicadas:**
Quando há múltiplos registros para o mesmo campaign_id, o sistema prioriza o com maior spend e descarta o obsoleto.`
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
        content: `**Fase 1 — Importação de campanhas (syncAdsQuick phase=1):**
Busca via Amazon Ads API todas as campanhas enabled/paused. Atualiza Campaign entity. Também atualiza inventário FBA via SP-API.

**Fase 2 — Download de relatórios (syncAdsQuick action=download):**
Baixa o relatório solicitado na Fase 1 (aguarda 2–10 minutos). Processa métricas diárias por campanha em CampaignMetricsDaily.

**Pipeline completo (runDailyFullReportPipeline):**
Combina Fase 1 + Fase 2 + métricas de vendas (SalesDaily via SP-API Orders Report) + disparo do motor de decisão.

**Tolerância de dados desatualizados:**
- < 26h: status OK (dentro do ciclo operacional)
- 26h–48h: banner de alerta (stale)
- > 48h: motor de decisão bloqueado por segurança`
      },
      {
        title: 'Dados de Vendas Reais (SP-API)',
        content: `Os dados de vendas reais vêm do relatório \`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL\` da SP-API.

**Entidade:** SalesDaily (asin × date × ordered_product_sales + units_ordered)

**Uso no motor de decisão:**
- Cálculo de TACoS real = gasto ads / faturamento real (não vendas atribuídas)
- Velocidade de vendas por ASIN para regras de estoque
- Validação de "has_real_sales" para guardrails de boost
- Cobertura de estoque = FBA inventory / velocidade de vendas

**Latência:** Dados de Orders têm ~24h de latência na Amazon. Não usar para decisões em tempo real.`
      },
      {
        title: 'Token OAuth e Autenticação',
        content: `**Amazon Ads API:**
Usa OAuth2 LWA (Login with Amazon). O refresh token é armazenado como secret ADS_REFRESH_TOKEN. O access token é gerado automaticamente em cada chamada via getOAuthSetupInfo.

**SP-API:**
Usa refresh token independente (SP_REFRESH_TOKEN). Autenticação via client credentials + refresh.

**Sinais de token expirado:**
- Erro "Not authorized" em campanhas
- Banner vermelho na dashboard com link para reautorizar
- Status "token_status != valid" em getOAuthSetupInfo

**Reautorização:** Ir para /amazon-oauth-setup e seguir o fluxo OAuth.`
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
Mede eficiência do anúncio. Target padrão: 10%. Máximo aceitável: 15%.

**TACoS (Total ACoS):**
\`gasto_ads / faturamento_real × 100\`
Mede impacto dos ads no negócio total. Mais preciso que ACoS para saúde geral.

**MPA (Margem Pós-Ads):**
\`(receita − custo_produto − taxas_amazon − gasto_ads) / receita × 100\`
Lucro real após todos os custos de publicidade.

**ROAS (Return on Ad Spend):**
\`vendas_atribuídas / gasto_ads\`
Target mínimo: 4x.

**CPC (Custo por Clique):**
Monitorado por keyword e por campanha. CPC máximo é configurável no AutopilotConfig.`
      },
      {
        title: 'Dashboard — Períodos e Fontes',
        content: `**Período padrão:** últimos 30 dias com exclusão do dia parcial (dados completos).

**Faturamento Total vs Vendas Ads:**
- "Vendas Ads" = vendas atribuídas aos anúncios (campo \`sales\` de CampaignMetricsDaily)
- "Faturamento Total" = dados de SalesDaily (ordered_product_sales via SP-API)
Os dois números são diferentes — vendas atribuídas têm latência de 14 dias na Amazon.

**Gráfico de Desempenho:**
ComposedChart unificado com: Gasto (barras), Vendas Ads (linha), Impressões (área).

**Deduplicação de campanhas:**
Quando há registros duplicados pelo mesmo campaign_id, o sistema prioriza o com maior spend para exibição.`
      },
      {
        title: 'Rentabilidade por Produto',
        content: `**Entidade:** ProductProfitabilityLearning (gerada semanalmente por generateProfitabilityLearningReport)

**Status de rentabilidade:**
- \`strong_profit\`: MPA > 20%
- \`healthy_profit\`: MPA 10–20%
- \`low_profit\`: MPA 0–10%
- \`break_even\`: MPA ≈ 0
- \`post_ads_loss\`: lucro bruto positivo mas negativo após ads
- \`gross_loss\`: **margem bruta negativa — ads bloqueados automaticamente**

**Bloqueios automáticos em gross_loss:**
- ads_blocked = true (nenhuma nova campanha criada)
- bid_increase_blocked = true (motor não aumenta bids)
- budget_increase_blocked = true`
      }
    ]
  },
  {
    id: 'configuracoes',
    icon: Settings,
    color: 'text-slate-400',
    bg: 'bg-surface-2 border-surface-3',
    title: 'Configurações e AutopilotConfig',
    subsections: [
      {
        title: 'Parâmetros Principais do AutopilotConfig',
        content: `**Metas financeiras:**
- \`target_acos\` (padrão: 10%) — meta de ACoS para regras nativas
- \`maximum_acos\` (padrão: 15%) — ACoS máximo antes de ação de emergência
- \`target_roas\` (padrão: 4) — meta de ROAS
- \`target_tacos\` (padrão: 5%) — TACoS alvo geral
- \`daily_budget_limit\` (padrão: 80) — limite diário de risco

**Limites de bid:**
- \`min_bid\` (padrão: R$0,50)
- \`max_bid\` (padrão: R$5,00)
- \`max_bid_increase_pct\` (padrão: 15%)
- \`max_bid_decrease_pct\` (padrão: 20%)

**Thresholds de decisão:**
- \`min_clicks_for_decision\` (padrão: 8 cliques)
- \`min_spend_for_decision\` (padrão: R$5)
- \`min_orders_for_scale\` (padrão: 2 pedidos)
- \`cooldown_hours\` (padrão: 24h)`
      },
      {
        title: 'Flags de Automação',
        content: `**Controles on/off:**
- \`harvest_enabled\`: ativa harvest de search terms convertidos
- \`auto_create_manual_exact\`: cria campanhas exact automaticamente ao promover termos
- \`negative_after_manual_delivery\`: negativar no AUTO quando promovido para EXACT
- \`auto_pause_zero_stock\`: pausar product ads sem estoque
- \`placement_optimization_enabled\`: ajuste de placement (topo de busca, resto, páginas de produto)
- \`dayparting_enabled\`: ajuste de bids por horário do dia
- \`emergency_pause_enabled\`: pausa de emergência em spike de gasto

**Modo de aprovação:**
- \`auto_apply_enabled = false\` (padrão): toda ação fica em fila pendente para revisão
- \`auto_apply_low_risk = true\`: ações de baixo risco são aplicadas sem aprovação`
      },
      {
        title: 'Objetivos de Campanha (objective)',
        content: `O campo \`objective\` no AutopilotConfig define o modo de operação do motor:

| Objetivo | Descrição | Comportamento |
|---|---|---|
| \`profitability\` | Maximizar lucro | Bids conservadores, ACoS restrito |
| \`growth\` | Crescimento de vendas | Bids moderados, aceita ACoS maior |
| \`launch\` | Lançamento de produto | Bids agressivos, impressões priorizadas |
| \`defense\` | Proteger posição | Mantém bids estáveis, foca em Buy Box |
| \`liquidation\` | Queimar estoque | Boosts máximos para zerar estoque |
| \`maintenance\` | Manutenção | Mínimo de mudanças, conserva status quo |`
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
        title: 'Diagnósticos Comuns',
        content: `**Motor não está executando ações:**
1. Verificar data_age_hours no resultado de runDeterministicDecisionEngine — se > 48h, sync está parado
2. Verificar cooldown: a mesma keyword só recebe ação após 24–72h
3. Verificar se há regras ativas (status = 'active') em DecisionRule
4. Verificar se o token OAuth está válido em /amazon-oauth-setup

**Campanhas não aparecem no Dashboard:**
1. Campanhas ARCHIVED são ignoradas por design
2. Campanhas duplicadas são deduplicadas pelo campaign_id com maior spend
3. Forçar sync: botão "Sincronizar" no Dashboard → runDailyFullReportPipeline

**executeStockBidRules retornando entityNotFoundError:**
Keywords com IDs inválidos (campanhas arquivadas). As ações são marcadas como 'skipped' automaticamente. Não impacta o funcionamento geral.

**TermBank não importando termos:**
Verificar se há search terms com orders_30d >= 3 na entidade SearchTerm. O sync de search terms ocorre via relatório diário.`
      },
      {
        title: 'Fluxo de Reautorização OAuth',
        content: `**Quando reautorizar:**
- Banner vermelho na dashboard com "Token inválido"
- Erros "Not authorized" ou "401" nos logs de sync
- Status "invalid" ou "expired" em getOAuthSetupInfo

**Como reautorizar:**
1. Ir para /amazon-oauth-setup
2. Clicar em "Conectar Amazon Ads"
3. Fazer login na Amazon e autorizar o app
4. O redirect retorna para /amazon-ads-callback com o código OAuth
5. O token é salvo automaticamente via exchangeAmazonAdsCode

**Nota:** O token expira após 1 hora. O refresh token é permanente e renova o access token automaticamente em cada chamada.`
      },
      {
        title: 'Sala de Comando — Monitoramento',
        content: `A página /sala-de-comando centraliza todos os logs operacionais:

**Alertas Ativos:** Gerados por checkAndCreateAlerts (ACoS alto, gasto anormal, estoque crítico)

**Fila de Ações Amazon:** AmazonActionQueue — ações pendentes de execução na API

**Fila de Execução de Regras:** RuleExecution — bids calculados pelo motor aguardando execução via executeStockBidRules

**Log de Bids:** AdsBidChangeLog — histórico de alterações de bid com reason, evidence e amazon_response

**Kick-off Queue:** ProductKickoffQueue — produtos aguardando criação de campanhas

**Reparos de Campanhas:** AutoCampaignRepairQueue — campanhas incompletas aguardando reparo`
      }
    ]
  },
  {
    id: 'fluxos-chave',
    icon: Activity,
    color: 'text-pink-400',
    bg: 'bg-pink-500/10 border-pink-500/20',
    title: 'Fluxos Operacionais Chave',
    subsections: [
      {
        title: 'Fluxo Completo: Produto Novo → Vendas',
        content: `\`\`\`
Produto cadastrado no FBA
        ↓
Product detectado no sync de inventário (status = active, fba_inventory > 0)
        ↓
processNewOrRestockedProductsForTermBank
  → IA gera termos iniciais (máx. 10, confiança ≥ 95%)
  → Salvo em TermBank + KeywordSuggestion
        ↓
Usuário aprova sugestões no TermBank
  → reviewKeywordSuggestion → createManualCampaignV2
  → Campanha EXACT criada na Amazon
        ↓
Kickoff AUTO (scheduleProductKickoff)
  → autoKickoffProductV3 → createAutoCampaignForAsin
  → Campanha AUTO criada na Amazon
        ↓
Motor diário monitora performance:
  → Regras de estoque ajustam bids conforme cobertura
  → Regras de ACoS ajustam bids conforme eficiência
  → Harvest: termos com ≥2 conversões → promovidos para EXACT
  → Waste cleanup: termos sem conversão → negativados no AUTO
\`\`\``
      },
      {
        title: 'Fluxo: Decisão de Bid → Execução na Amazon',
        content: `\`\`\`
runDeterministicDecisionEngine
  → Avalia keywords por regras de estoque + ACoS + DecisionRule
  → Cria registros em RuleExecution (status = pending)
        ↓
executeStockBidRules (chamado no pipeline diário)
  → Lê RuleExecution com status = pending
  → PUT /keywords/{id} na Amazon Ads API
  → Atualiza RuleExecution: status = executed
  → Cria registro em AdsBidChangeLog com:
      old_bid, new_bid, change_percent, reason, amazon_response
        ↓
Resultado visível em:
  → /bid-logs (histórico completo)
  → /sala-de-comando (fila em tempo real)
\`\`\``
      },
      {
        title: 'Fluxo: IA Semanal → Regra Ativa',
        content: `\`\`\`
runWeeklyClaudeRuleReview (segunda-feira 08:00 UTC)
  → Carrega 30 dias de métricas
  → Claude analisa padrões e propõe regras
  → Valida schema (campos obrigatórios, operadores permitidos)
  → Backtest histórico (testa regra nos últimos 30 dias)
  → Se aprovada no backtest → status = 'validating'
        ↓
WeeklyRuleReview criado para revisão do usuário
  → Usuário aprova/rejeita em /autopilot
        ↓
Se aprovada → DecisionRule status = 'active'
        ↓
Motor diário (Módulo B) executa a regra
  → Cooldown próprio por entidade
  → Respeitando todos os guardrails financeiros
\`\`\``
      }
    ]
  }
];

function SectionBadge({ color, bg, icon: Icon, title, isOpen, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-5 py-4 rounded-xl border transition-all ${bg} ${isOpen ? 'ring-1 ring-white/10' : 'hover:bg-white/5'}`}
    >
      <div className="flex items-center gap-3">
        <Icon className={`h-5 w-5 flex-shrink-0 ${color}`} />
        <span className="font-semibold text-white text-sm">{title}</span>
      </div>
      {isOpen ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
    </button>
  );
}

function ContentBlock({ content }) {
  const lines = content.split('\n');
  return (
    <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith('```')) return null;
        if (line.startsWith('**') && line.endsWith('**')) {
          return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{line.replace(/\*\*/g, '')}</p>;
        }
        if (line.startsWith('| ') && line.endsWith(' |')) {
          // tabela
          const cells = line.split('|').filter(c => c.trim() !== '');
          const isHeader = lines[i + 1]?.startsWith('|---');
          const isSeparator = line.includes('---');
          if (isSeparator) return null;
          return (
            <div key={i} className={`grid gap-2 text-xs ${cells.length === 3 ? 'grid-cols-3' : cells.length === 2 ? 'grid-cols-2' : 'grid-cols-4'} ${isHeader ? 'text-slate-500 border-b border-surface-2 pb-1' : 'py-1 border-b border-surface-2/40'}`}>
              {cells.map((c, j) => <span key={j} className={isHeader ? 'font-semibold uppercase tracking-wide text-[10px]' : 'text-slate-300'}>{c.trim().replace(/`/g, '')}</span>)}
            </div>
          );
        }
        if (line.startsWith('- ') || line.startsWith('→ ')) {
          const text = line.slice(2);
          const parts = text.split(/`([^`]+)`/);
          return (
            <p key={i} className="flex gap-2">
              <span className="text-slate-500 flex-shrink-0 mt-0.5">{line[0] === '-' ? '•' : '→'}</span>
              <span>
                {parts.map((p, j) => j % 2 === 0
                  ? p.replace(/\*\*/g, '')
                  : <code key={j} className="bg-surface-2 px-1 py-0.5 rounded text-cyan text-[11px] font-mono">{p}</code>
                )}
              </span>
            </p>
          );
        }
        if (line.trim() === '') return <div key={i} className="h-1" />;
        // código inline e bold inline
        const parts = line.split(/`([^`]+)`/);
        const boldParts = (str) => str.split(/\*\*([^*]+)\*\*/).map((s, j) =>
          j % 2 === 0 ? s : <strong key={j} className="text-white font-semibold">{s}</strong>
        );
        return (
          <p key={i}>
            {parts.map((p, j) => j % 2 === 0
              ? boldParts(p)
              : <code key={j} className="bg-surface-2 px-1 py-0.5 rounded text-cyan text-[11px] font-mono">{p}</code>
            )}
          </p>
        );
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
    <div className="max-w-4xl mx-auto space-y-6 p-6">
      {/* Header */}
      <div className="rounded-2xl border border-cyan/20 bg-cyan/5 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <BookOpen className="h-6 w-6 text-cyan" />
              <h1 className="text-xl font-bold text-white">Manual de Instruções — LivingFinds</h1>
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

        {/* Status badges */}
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            { icon: Zap, label: 'Motor Determinístico Ativo', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
            { icon: Brain, label: 'IA Semanal (Claude)', color: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
            { icon: ShieldCheck, label: 'Guardrails Financeiros', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
            { icon: Package, label: 'Regras de Estoque Nativas', color: 'text-cyan bg-cyan/10 border-cyan/20' },
            { icon: DollarSign, label: 'Regras de ACoS Nativas', color: 'text-pink-400 bg-pink-500/10 border-pink-500/20' },
          ].map(({ icon: Icon, label, color }) => (
            <span key={label} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${color}`}>
              <Icon className="h-3 w-3" />{label}
            </span>
          ))}
        </div>
      </div>

      {/* Índice rápido */}
      <div className="rounded-xl border border-surface-2 bg-surface-1 p-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Índice</p>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return (
              <button key={s.id} onClick={() => { setOpenSection(s.id); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-surface-2 transition-colors text-left">
                <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${s.color}`} />
                {s.title}
              </button>
            );
          })}
        </div>
      </div>

      {/* Seções */}
      {SECTIONS.map(section => {
        const isOpen = openSection === section.id;
        return (
          <div key={section.id} id={section.id} className="space-y-2">
            <SectionBadge
              color={section.color}
              bg={section.bg}
              icon={section.icon}
              title={section.title}
              isOpen={isOpen}
              onClick={() => toggleSection(section.id)}
            />
            {isOpen && (
              <div className="ml-2 space-y-2">
                {section.subsections.map((sub, si) => {
                  const key = `${section.id}-${si}`;
                  const subOpen = openSubsections[key] !== false; // aberto por padrão
                  return (
                    <div key={key} className="rounded-xl border border-surface-2 bg-surface-1 overflow-hidden">
                      <button
                        onClick={() => toggleSubsection(key)}
                        className="w-full flex items-center justify-between px-5 py-3 hover:bg-surface-2/50 transition-colors"
                      >
                        <span className="text-sm font-medium text-white">{sub.title}</span>
                        {subOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
                      </button>
                      {subOpen && (
                        <div className="px-5 pb-5 border-t border-surface-2">
                          <div className="pt-4">
                            <ContentBlock content={sub.content} />
                          </div>
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
      <div className="rounded-xl border border-surface-2 bg-surface-1 px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
          <span>Versão <strong className="text-white">v{VERSION}</strong> — Certificada em {VERSION_DATE}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Clock className="h-3 w-3" />
          Pipeline diário: 09:00 UTC
        </div>
      </div>
    </div>
  );
}