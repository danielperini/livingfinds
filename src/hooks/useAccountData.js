/**
 * useAccountData — camada única de dados compartilhada
 *
 * Centraliza TODAS as chamadas de entidades usadas pelo Dashboard, IA e relatórios.
 * O contexto canônico (canonicalContext) é produzido pelo backend getCanonicalAccountContext,
 * que usa EXATAMENTE as mesmas queries e agregações do motor determinístico —
 * garantindo que o Dashboard exibe os mesmos números que a IA usa para decisões.
 *
 * Uso:
 *   const { account, campaigns, metricsDaily, canonicalContext, loading } = useAccountData();
 *
 * canonicalContext contém:
 *   - settings: metas de performance (mesma cascata do motor)
 *   - kpis_14d / kpis_30d / kpis_yesterday: KPIs agregados e deduplificados
 *   - real_kpis_30d: faturamento real (SP-API)
 *   - goal_status: metas vs realidade, mesmo cálculo do motor
 *   - data_quality: diagnóstico de frescor dos dados
 *   - daily_series: série temporal para gráficos
 */

import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns } from '@/lib/campaignUtils';

const STALE_5MIN = 5 * 60 * 1000;
const STALE_1MIN = 60 * 1000;
const STALE_2MIN = 2 * 60 * 1000;

// ── Resolve a conta ativa do usuário atual ──────────────────────────────────
async function fetchAccount() {
  const me = await base44.auth.me();
  const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }, '-updated_date', 5);
  return {
    user: me,
    account: accounts.find(a => a.status === 'connected') || accounts[0] || null,
  };
}

// ── Contexto canônico — MESMA visão que o motor de IA usa ──────────────────
// Backend getCanonicalAccountContext agrega dados com as mesmas queries e filtros
// de runDeterministicDecisionEngine, garantindo consistência Dashboard↔Motor.
async function fetchCanonicalContext(accountId) {
  const res = await base44.functions.invoke('getCanonicalAccountContext', { amazon_account_id: accountId });
  return res?.data || null;
}

// ── Queries de entidades brutas (para funcionalidades que precisam de registros individuais) ──
async function fetchCampaigns(accountId) {
  return loadAllCampaigns(accountId);
}

async function fetchMetricsDaily(accountId) {
  return base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 5000);
}

async function fetchProducts(accountId) {
  return base44.entities.Product.filter({ amazon_account_id: accountId }, '-fba_inventory', 500);
}

async function fetchSalesDaily(accountId) {
  const since62 = new Date(Date.now() - 62 * 86400000).toISOString().slice(0, 10);
  return base44.entities.SalesDaily.filter(
    { amazon_account_id: accountId, date: { $gte: since62 } },
    '-date',
    2000
  );
}

async function fetchDecisions(accountId) {
  const [pending, all] = await Promise.all([
    base44.entities.OptimizationDecision.filter({ amazon_account_id: accountId, status: 'pending' }, '-created_at', 10),
    base44.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 2000),
  ]);
  return { pending, all };
}

async function fetchBidChanges(accountId) {
  return base44.entities.AdsBidChangeLog.filter({ amazon_account_id: accountId }, '-created_at', 2000);
}

async function fetchSyncRuns(accountId) {
  return base44.entities.SyncExecutionLog.filter({ amazon_account_id: accountId }, '-started_at', 5);
}

async function fetchAutopilotConfig(accountId) {
  const configs = await base44.entities.AutopilotConfig.filter({ amazon_account_id: accountId });
  return configs[0] || null;
}

async function fetchBudgetConfig(accountId) {
  const cfgs = await base44.entities.BudgetConfiguration.filter({ amazon_account_id: accountId });
  return cfgs[0] || null;
}

async function fetchPerformanceSettings(accountId) {
  const list = await base44.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1);
  return list[0] || null;
}

async function fetchSellerBenchmark(accountId) {
  const benchmarks = await base44.entities.SellerPerformanceBenchmark.filter(
    { amazon_account_id: accountId },
    '-period_end',
    5
  );
  return benchmarks[0] || null;
}

// ── Hook principal ──────────────────────────────────────────────────────────

export function useAccountData() {
  // 1. Conta e usuário (base de tudo)
  const accountQuery = useQuery({
    queryKey: ['account'],
    queryFn: fetchAccount,
    staleTime: STALE_5MIN,
  });

  const accountId = accountQuery.data?.account?.id ?? null;
  const enabled = !!accountId;

  // 2. Contexto canônico — a mesma visão que o motor determinístico usa
  //    staleTime curto pois reflete decisões do motor que rodam diariamente
  const canonicalContextQuery = useQuery({
    queryKey: ['canonicalContext', accountId],
    queryFn: () => fetchCanonicalContext(accountId),
    enabled,
    staleTime: STALE_2MIN,
  });

  // 3. Dados de entidades brutas — para funcionalidades que precisam de registros individuais
  const campaignsQuery = useQuery({
    queryKey: ['campaigns', accountId],
    queryFn: () => fetchCampaigns(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  const metricsDailyQuery = useQuery({
    queryKey: ['metricsDaily', accountId],
    queryFn: () => fetchMetricsDaily(accountId),
    enabled,
    staleTime: STALE_1MIN,
  });

  const productsQuery = useQuery({
    queryKey: ['products', accountId],
    queryFn: () => fetchProducts(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  const salesDailyQuery = useQuery({
    queryKey: ['salesDaily', accountId],
    queryFn: () => fetchSalesDaily(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  const decisionsQuery = useQuery({
    queryKey: ['decisions', accountId],
    queryFn: () => fetchDecisions(accountId),
    enabled,
    staleTime: STALE_1MIN,
  });

  const bidChangesQuery = useQuery({
    queryKey: ['bidChanges', accountId],
    queryFn: () => fetchBidChanges(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  const syncRunsQuery = useQuery({
    queryKey: ['syncRuns', accountId],
    queryFn: () => fetchSyncRuns(accountId),
    enabled,
    staleTime: STALE_1MIN,
  });

  const autopilotConfigQuery = useQuery({
    queryKey: ['autopilotConfig', accountId],
    queryFn: () => fetchAutopilotConfig(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  const budgetConfigQuery = useQuery({
    queryKey: ['budgetConfig', accountId],
    queryFn: () => fetchBudgetConfig(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  const performanceSettingsQuery = useQuery({
    queryKey: ['performanceSettings', accountId],
    queryFn: () => fetchPerformanceSettings(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  const sellerBenchmarkQuery = useQuery({
    queryKey: ['sellerBenchmark', accountId],
    queryFn: () => fetchSellerBenchmark(accountId),
    enabled,
    staleTime: STALE_5MIN,
  });

  // ── Estado de loading agregado ──────────────────────────────────────────
  const loading =
    accountQuery.isLoading ||
    (enabled && (
      campaignsQuery.isLoading ||
      metricsDailyQuery.isLoading ||
      productsQuery.isLoading ||
      salesDailyQuery.isLoading
    ));

  const error =
    accountQuery.error?.message ||
    campaignsQuery.error?.message ||
    metricsDailyQuery.error?.message ||
    null;

  return {
    // Identidade
    user: accountQuery.data?.user ?? null,
    account: accountQuery.data?.account ?? null,

    // ── CONTEXTO CANÔNICO — mesma visão que o motor de IA ──
    // Usar canonicalContext.kpis_14d e .settings para decisões críticas de exibição
    canonicalContext: canonicalContextQuery.data ?? null,
    canonicalLoading: canonicalContextQuery.isLoading,

    // Dados principais (entidades brutas — para listas, tabelas, etc.)
    campaigns: campaignsQuery.data ?? [],
    metricsDaily: metricsDailyQuery.data ?? [],
    products: productsQuery.data ?? [],
    salesDaily: salesDailyQuery.data ?? [],

    // Decisões
    decisions: decisionsQuery.data?.pending ?? [],
    allDecisions: decisionsQuery.data?.all ?? [],

    // Atividade e configuração
    bidChanges: bidChangesQuery.data ?? [],
    syncRuns: syncRunsQuery.data ?? [],
    autopilotConfig: autopilotConfigQuery.data ?? null,
    budgetCfg: budgetConfigQuery.data ?? null,
    performanceSettings: performanceSettingsQuery.data ?? null,
    sellerBenchmark: sellerBenchmarkQuery.data ?? null,

    // Estado
    loading,
    error,

    // Queries individuais — para casos que precisam do isLoading específico
    queries: {
      account: accountQuery,
      canonicalContext: canonicalContextQuery,
      campaigns: campaignsQuery,
      metricsDaily: metricsDailyQuery,
      products: productsQuery,
      salesDaily: salesDailyQuery,
      decisions: decisionsQuery,
      bidChanges: bidChangesQuery,
      syncRuns: syncRunsQuery,
      autopilotConfig: autopilotConfigQuery,
      budgetConfig: budgetConfigQuery,
      performanceSettings: performanceSettingsQuery,
      sellerBenchmark: sellerBenchmarkQuery,
    },
  };
}

// ── Helper de invalidação — use no queryClientInstance de qualquer componente
export function invalidateAccountData(queryClient, accountId) {
  const keys = [
    ['account'],
    ['canonicalContext', accountId],
    ['campaigns', accountId],
    ['metricsDaily', accountId],
    ['products', accountId],
    ['salesDaily', accountId],
    ['decisions', accountId],
    ['bidChanges', accountId],
    ['syncRuns', accountId],
    ['autopilotConfig', accountId],
    ['budgetConfig', accountId],
    ['performanceSettings', accountId],
    ['sellerBenchmark', accountId],
  ];
  return Promise.all(keys.map(k => queryClient.invalidateQueries({ queryKey: k })));
}