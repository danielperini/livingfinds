import { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Activity, AlertTriangle, Gauge, Loader2, Play, RefreshCw, ShieldCheck, TrendingDown } from 'lucide-react';

const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
const money = (value) => `R$${Number(value || 0).toFixed(2)}`;

const CLASS_LABELS = {
  NEW_PENDING_INSERTION: 'Em inserção',
  NEW_NO_IMPRESSIONS: 'Nova sem impressões',
  NEW_IMPRESSIONS_NO_CLICKS: 'Impressões sem clique',
  LEARNING_LOW_TRAFFIC: 'Aprendizado · pouco tráfego',
  LEARNING_BALANCED: 'Aprendizado equilibrado',
  OVERSHARE_NO_CONVERSION: 'Concentração sem conversão',
  OVERSHARE_WITH_CONVERSION: 'Concentração com conversão',
  LOW_VOLUME_GUARDED: 'Baixo volume protegido',
  PROTECTED_WINNER: 'Vencedora protegida',
  ECONOMICALLY_UNSAFE: 'Dados econômicos incompletos',
  OUT_OF_STOCK: 'Sem estoque',
  DATA_STALE: 'Dados desatualizados',
  INCOMPLETE: 'Estrutura incompleta',
  NOT_ELIGIBLE: 'Não elegível',
};

const CLASS_COLORS = {
  OVERSHARE_NO_CONVERSION: 'text-red-300 bg-red-500/10 border-red-500/20',
  PROTECTED_WINNER: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  NEW_NO_IMPRESSIONS: 'text-cyan bg-cyan/10 border-cyan/20',
  NEW_IMPRESSIONS_NO_CLICKS: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
  ECONOMICALLY_UNSAFE: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
};

export default function EconomicBudgetBalancerPanel({ account, config }) {
  const [running, setRunning] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const accountResult = result?.accounts?.[0] || null;

  const actionByCampaign = useMemo(() => {
    const map = new Map();
    for (const action of [...(accountResult?.proposed || []), ...(accountResult?.executed || [])]) {
      map.set(String(action.campaign_id), action);
    }
    return map;
  }, [accountResult]);

  const run = async (dryRun) => {
    if (!account?.id || running) return;
    if (!dryRun && !window.confirm('Executar agora os ajustes econômicos habilitados e confirmá-los pela Amazon Ads API?')) return;
    setRunning(dryRun ? 'dry' : 'live');
    setError('');
    try {
      const response = await base44.functions.invoke('runEconomicBudgetBalancer', {
        amazon_account_id: account.id,
        dry_run: dryRun,
        skip_sync: false,
      });
      const data = response?.data || response || {};
      if (data.ok === false) throw new Error(data.error || 'Falha no balanceador econômico');
      setResult(data);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Falha no balanceador econômico');
    } finally {
      setRunning(null);
    }
  };

  const campaigns = [...(accountResult?.campaigns || [])].sort((a, b) => Number(b.spend_share || 0) - Number(a.spend_share || 0));
  const counts = accountResult?.classifications || {};
  const zeroImpressions = Number(counts.NEW_NO_IMPRESSIONS || 0);
  const zeroClicks = Number(counts.NEW_IMPRESSIONS_NO_CLICKS || 0);
  const concentration = Number(counts.OVERSHARE_NO_CONVERSION || 0) + Number(counts.OVERSHARE_WITH_CONVERSION || 0);
  const protectedWinners = Number(counts.PROTECTED_WINNER || 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan/20 bg-cyan/5 p-4">
        <div>
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-cyan" />
            <h3 className="text-sm font-semibold text-white">Balanceador econômico de tráfego</h3>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Distribui pressão de leilão por bid e budget real. Nunca pausa campanha somente por falta de venda.
          </p>
          <p className={`mt-1 text-[11px] ${config?.economic_budget_balancer_enabled ? 'text-emerald-400' : 'text-amber-400'}`}>
            {config?.economic_budget_balancer_enabled
              ? 'Feature flag ativa para esta conta.'
              : 'Feature flag desligada: ciclos reais são convertidos em simulação.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => run(true)} disabled={!!running}
            className="flex items-center gap-1.5 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs font-semibold text-slate-300 hover:text-white disabled:opacity-50">
            {running === 'dry' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Simular com dados reais
          </button>
          <button onClick={() => run(false)} disabled={!!running || !config?.economic_budget_balancer_enabled}
            className="flex items-center gap-1.5 rounded-lg bg-cyan px-3 py-2 text-xs font-bold text-white hover:bg-cyan/90 disabled:opacity-40">
            {running === 'live' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Executar agora
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

      {!accountResult && !error && (
        <div className="rounded-xl border border-surface-2 bg-surface-1 p-8 text-center text-sm text-slate-500">
          Execute o dry-run para sincronizar dados reais e visualizar gasto, participação-alvo, classificações e bids propostos.
        </div>
      )}

      {accountResult && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            {[
              ['Gasto diário', money(accountResult.account_daily_spend), Activity],
              ['Budget restante', money(accountResult.remaining_account_budget), Gauge],
              ['Concentradoras', concentration, AlertTriangle],
              ['Sem impressões', zeroImpressions, RefreshCw],
              ['Sem clique', zeroClicks, TrendingDown],
              ['Protegidas', protectedWinners, ShieldCheck],
              ['Bids propostos', accountResult.changes_proposed || 0, Play],
              ['Economia estimada', money(accountResult.estimated_savings), TrendingDown],
            ].map(([label, value, Icon]) => (
              <div key={label} className="rounded-xl border border-surface-2 bg-surface-1 p-3">
                <Icon className="mb-2 h-3.5 w-3.5 text-cyan" />
                <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
                <p className="mt-0.5 text-sm font-bold text-white">{value}</p>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-surface-2">
            <div className="flex items-center justify-between border-b border-surface-2 bg-surface-1 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-white">Distribuição diária por campanha</p>
                <p className="text-[11px] text-slate-500">{accountResult.campaigns_analyzed} campanhas Sponsored Products analisadas</p>
              </div>
              <span className="text-[11px] text-slate-500">{result.dry_run ? 'DRY-RUN' : 'EXECUÇÃO REAL'}</span>
            </div>
            <div className="max-h-[620px] overflow-auto">
              <table className="w-full min-w-[1050px]">
                <thead className="sticky top-0 bg-surface-1">
                  <tr className="border-b border-surface-2 text-left text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2">Campanha</th>
                    <th className="px-3 py-2">Classificação</th>
                    <th className="px-3 py-2">Gasto</th>
                    <th className="px-3 py-2">Share / alvo</th>
                    <th className="px-3 py-2">Impr. / cliques</th>
                    <th className="px-3 py-2">Vendas</th>
                    <th className="px-3 py-2">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((campaign) => {
                    const action = actionByCampaign.get(String(campaign.campaign_id));
                    return (
                      <tr key={campaign.campaign_id} className="border-b border-surface-2/50 align-top hover:bg-surface-2/30">
                        <td className="px-4 py-3">
                          <p className="max-w-[260px] truncate text-xs font-medium text-white">{campaign.campaign_name || campaign.campaign_id}</p>
                          <p className="mt-0.5 text-[10px] text-slate-500">{campaign.targeting_type} · {campaign.asin || campaign.sku || 'sem ASIN/SKU'}</p>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`rounded-full border px-2 py-1 text-[10px] ${CLASS_COLORS[campaign.classification] || 'border-surface-3 bg-surface-2 text-slate-400'}`}>
                            {CLASS_LABELS[campaign.classification] || campaign.classification}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-300">{money(campaign.spend)}</td>
                        <td className="px-3 py-3 text-xs">
                          <span className={Number(campaign.spend_share) > Number(campaign.target_share) ? 'text-red-300' : 'text-slate-300'}>{pct(campaign.spend_share)}</span>
                          <span className="text-slate-600"> / {pct(campaign.target_share)}</span>
                          <p className="mt-0.5 text-[10px] text-slate-600">virtual {money(campaign.virtual_budget)}</p>
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-400">{campaign.impressions} / {campaign.clicks}</td>
                        <td className="px-3 py-3 text-xs text-slate-400">{campaign.orders} · {money(campaign.sales)}</td>
                        <td className="px-3 py-3">
                          {action ? (
                            <div className="max-w-[310px]">
                              <p className={`text-xs font-semibold ${action.change_pct < 0 ? 'text-amber-300' : 'text-cyan'}`}>
                                {action.action.includes('bid') ? 'Bid' : 'Budget'}: {money(action.value_before)} → {money(action.value_after)} ({action.change_pct > 0 ? '+' : ''}{(Number(action.change_pct) * 100).toFixed(1)}%)
                              </p>
                              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{action.reason}</p>
                              <p className="mt-1 text-[10px] text-slate-600">Próxima avaliação: {new Date(action.next_evaluation_at).toLocaleString('pt-BR')}</p>
                            </div>
                          ) : <span className="text-[10px] text-slate-600">Observar / sem ação segura</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
