import { useCallback, useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Calculator, Loader2, RefreshCw, Target, TrendingUp } from 'lucide-react';

const money = (value) => `R$${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = (value) => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

function Card({ label, value, detail, tone = 'text-white' }) {
  return <div className="rounded-xl border border-surface-2 bg-surface-1 p-4">
    <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
    <p className={`mt-1 text-xl font-bold ${tone}`}>{value}</p>
    {detail && <p className="mt-1 text-[11px] text-slate-500">{detail}</p>}
  </div>;
}

export default function ProfitProjectionPanel({ account }) {
  const [assessments, setAssessments] = useState([]);
  const [economics, setEconomics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [monthlyGoal, setMonthlyGoal] = useState(10000);
  const [adsPercent, setAdsPercent] = useState('');

  const load = useCallback(async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const [daily, economicsRows] = await Promise.all([
        base44.entities.DailyProductAdsAssessment.filter({ amazon_account_id: account.id }, '-assessment_date', 5000).catch(() => []),
        base44.entities.ProductEconomics.filter({ amazon_account_id: account.id }, '-updated_at', 5000).catch(() => []),
      ]);
      setAssessments(daily || []);
      setEconomics(economicsRows || []);
    } finally { setLoading(false); }
  }, [account?.id]);

  useEffect(() => { load(); }, [load]);

  const model = useMemo(() => {
    const byDateAsin = new Map();
    for (const row of assessments) {
      if (!row.assessment_date || !row.asin) continue;
      const key = `${row.assessment_date}:${row.asin}`;
      if (!byDateAsin.has(key)) byDateAsin.set(key, row);
    }
    const rows = [...byDateAsin.values()];
    const dates = [...new Set(rows.map((row) => row.assessment_date))].sort();
    const latestDates = dates.slice(-Math.max(30, Math.min(180, dates.length)));
    const scope = new Set(latestDates);
    const sample = rows.filter((row) => scope.has(row.assessment_date));
    const totals = sample.reduce((acc, row) => ({
      profit: acc.profit + Number(row.profit_after_ads || 0),
      spend: acc.spend + Number(row.spend || 0),
      sales: acc.sales + Number(row.real_sales || row.ads_sales || 0),
      units: acc.units + Number(row.units_real || row.orders_ads || 0),
    }), { profit: 0, spend: 0, sales: 0, units: 0 });
    const profitableAsins = new Set(sample.filter((row) => Number(row.units_real || row.orders_ads || 0) > 0 && Number(row.profit_after_ads || 0) > 0).map((row) => row.asin));
    const fallback = economics.filter((row) => Number(row.profit_after_ads || 0) > 0 && Number(row.average_sale_price || row.current_price || 0) > 0);
    const salesPerUnit = totals.units > 0 ? totals.sales / totals.units : fallback.reduce((sum, row) => sum + Number(row.average_sale_price || row.current_price), 0) / Math.max(1, fallback.length);
    const profitPerUnit = totals.units > 0 ? totals.profit / totals.units : fallback.reduce((sum, row) => sum + Number(row.profit_after_ads), 0) / Math.max(1, fallback.length);
    const observedAdsPercent = totals.sales > 0 ? totals.spend / totals.sales * 100 : 0;
    return { dates: latestDates, totals, salesPerUnit, profitPerUnit, observedAdsPercent, activeSkus: profitableAsins.size || fallback.length };
  }, [assessments, economics]);

  const selectedAdsPercent = adsPercent === '' ? model.observedAdsPercent : Math.max(0, Number(adsPercent));
  const adjustedProfitPerUnit = model.totals.units > 0 ? model.profitPerUnit + model.salesPerUnit * ((model.observedAdsPercent - selectedAdsPercent) / 100) : 0;
  const safeProfitPerUnit = Math.max(0, adjustedProfitPerUnit);
  const unitsNeededMonth = safeProfitPerUnit > 0 ? Math.ceil(Number(monthlyGoal || 0) / safeProfitPerUnit) : 0;
  const unitsNeededDay = unitsNeededMonth / 30;
  const projectedRevenue = unitsNeededMonth * model.salesPerUnit;
  const projectedAds = projectedRevenue * selectedAdsPercent / 100;
  const projectedRoi = projectedAds > 0 ? Number(monthlyGoal || 0) / projectedAds : 0;
  const avgSkuMonthlyProfit = model.activeSkus > 0 && model.dates.length > 0 ? (model.totals.profit / model.dates.length * 30) / model.activeSkus : 0;
  const skusNeeded = avgSkuMonthlyProfit > 0 ? Math.ceil(Number(monthlyGoal || 0) / avgSkuMonthlyProfit) : 0;
  const additionalSkus = Math.max(0, skusNeeded - model.activeSkus);
  const dataReady = model.dates.length >= 30 && safeProfitPerUnit > 0;

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-cyan" /></div>;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-base font-bold text-white"><Calculator className="h-4 w-4 text-cyan" /> Projeção de Lucro</h2><p className="mt-0.5 text-xs text-slate-400">Modelo baseado em {model.dates.length} dias reais de aferição econômica. O mínimo para projeção é 30 dias; novos dias entram automaticamente no cálculo.</p></div>
      <button onClick={load} className="rounded-lg border border-surface-3 bg-surface-2 p-2 text-slate-400 hover:text-white" title="Atualizar dados"><RefreshCw className="h-3.5 w-3.5" /></button>
    </div>
    <div className="grid gap-3 rounded-xl border border-cyan/20 bg-cyan/5 p-4 md:grid-cols-2">
      <label className="text-xs text-slate-300">Meta de lucro mensal (R$)<input type="number" min="0" value={monthlyGoal} onChange={(event) => setMonthlyGoal(event.target.value)} className="mt-1.5 w-full rounded-lg border border-surface-3 bg-surface-1 px-3 py-2 text-sm text-white outline-none focus:border-cyan" /></label>
      <label className="text-xs text-slate-300">Investimento Ads (% da receita)<input type="number" min="0" max="100" step="0.1" placeholder={model.observedAdsPercent.toFixed(1)} value={adsPercent} onChange={(event) => setAdsPercent(event.target.value)} className="mt-1.5 w-full rounded-lg border border-surface-3 bg-surface-1 px-3 py-2 text-sm text-white outline-none focus:border-cyan" /><span className="mt-1 block text-[10px] text-slate-500">Em branco: usa o histórico observado de {model.observedAdsPercent.toFixed(1)}%.</span></label>
    </div>
    {!dataReady && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">Dados insuficientes para uma projeção confiável. São necessários pelo menos 30 dias e lucro unitário positivo confirmado na aferição econômica.</div>}
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card label="Lucro unitário projetado" value={money(safeProfitPerUnit)} detail={`Média real ajustada pelo Ads de ${selectedAdsPercent.toFixed(1)}%`} tone={safeProfitPerUnit > 0 ? 'text-emerald-400' : 'text-red-400'} />
      <Card label="Unidades por dia" value={number(unitsNeededDay)} detail={`${number(unitsNeededMonth)} unidades/mês`} tone="text-cyan" />
      <Card label="Receita mensal prevista" value={money(projectedRevenue)} detail={`Ticket médio ${money(model.salesPerUnit)}`} />
      <Card label="ROI sobre Ads" value={`${projectedRoi.toFixed(2)}x`} detail={`Investimento previsto ${money(projectedAds)}`} tone={projectedRoi >= 1 ? 'text-emerald-400' : 'text-amber-400'} />
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-surface-2 bg-surface-1 p-4"><p className="flex items-center gap-2 text-sm font-semibold text-white"><Target className="h-4 w-4 text-cyan" /> Capacidade de portfólio</p><div className="mt-4 grid grid-cols-3 gap-3 text-center"><div><p className="text-xl font-bold text-white">{model.activeSkus}</p><p className="text-[10px] text-slate-500">SKUs lucrativos observados</p></div><div><p className="text-xl font-bold text-cyan">{skusNeeded}</p><p className="text-[10px] text-slate-500">SKUs equivalentes necessários</p></div><div><p className="text-xl font-bold text-amber-400">{additionalSkus}</p><p className="text-[10px] text-slate-500">SKUs adicionais estimados</p></div></div></div>
      <div className="rounded-xl border border-surface-2 bg-surface-1 p-4"><p className="flex items-center gap-2 text-sm font-semibold text-white"><TrendingUp className="h-4 w-4 text-emerald-400" /> Sugestão orientada por dados</p><p className="mt-3 text-sm leading-relaxed text-slate-300">{safeProfitPerUnit > 0 ? `Para alcançar ${money(monthlyGoal)}, a loja precisa sustentar cerca de ${number(unitsNeededDay)} unidades/dia. Antes de ampliar o catálogo, priorize os ${model.activeSkus} SKUs com lucro confirmado e mantenha Ads em até ${selectedAdsPercent.toFixed(1)}% da receita simulada.` : 'A margem projetada não é positiva com os dados e o nível de Ads informado. Revise preço, custos, taxa Amazon ou reduza o investimento em Ads antes de buscar escala.'}</p></div>
    </div>
    <p className="text-[10px] text-slate-500">Projeção financeira, não garantia de resultado. O cálculo usa lucro pós-Ads, receita, unidades e investimento efetivamente registrados; dados parciais reduzem a confiabilidade.</p>
  </div>;
}
