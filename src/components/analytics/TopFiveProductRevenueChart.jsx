import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

function productTitle(product) {
  return String(
    product?.title
      || product?.product_name
      || product?.name
      || product?.item_name
      || product?.listing_title
      || product?.asin
      || 'Produto sem título'
  ).trim();
}

function shortTitle(value, max = 34) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function brl(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  }).format(Number(value || 0));
}

export default function TopFiveProductRevenueChart() {
  const [state, setState] = useState({ loading: true, error: null, products: [], campaigns: [], metrics: [] });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await base44.auth.me();
        let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
        if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
        const account = accounts[0];
        if (!account) throw new Error('Conta Amazon não encontrada.');

        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const [products, campaigns, metrics] = await Promise.all([
          base44.entities.Product.filter({ amazon_account_id: account.id }, '-updated_at', 2000),
          base44.entities.Campaign.filter({ amazon_account_id: account.id }, '-created_at', 3000),
          base44.entities.CampaignMetricsDaily.filter(
            { amazon_account_id: account.id, date: { $gte: cutoff } },
            '-date',
            5000
          ),
        ]);

        if (active) setState({ loading: false, error: null, products, campaigns, metrics });
      } catch (error) {
        if (active) setState({ loading: false, error: error.message, products: [], campaigns: [], metrics: [] });
      }
    })();
    return () => { active = false; };
  }, []);

  const data = useMemo(() => {
    const productMap = new Map(state.products.filter((p) => p.asin).map((p) => [String(p.asin), p]));
    const campaignAsinMap = new Map();
    for (const campaign of state.campaigns) {
      const asin = campaign.asin ? String(campaign.asin) : null;
      if (!asin) continue;
      if (campaign.campaign_id) campaignAsinMap.set(String(campaign.campaign_id), asin);
      if (campaign.amazon_campaign_id) campaignAsinMap.set(String(campaign.amazon_campaign_id), asin);
    }

    const seen = new Set();
    const totals = new Map();
    for (const metric of state.metrics) {
      const date = String(metric.date || '').slice(0, 10);
      const campaignId = String(metric.campaign_id || '');
      if (!date || !campaignId) continue;
      const dedupeKey = `${campaignId}:${date}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const asin = campaignAsinMap.get(campaignId);
      if (!asin) continue;
      const current = totals.get(asin) || { receita: 0, spend: 0 };
      current.receita += Number(metric.sales || 0);
      current.spend += Number(metric.spend || 0);
      totals.set(asin, current);
    }

    return [...totals.entries()]
      .map(([asin, values]) => {
        const product = productMap.get(asin);
        const fullTitle = productTitle(product || { asin });
        return {
          asin,
          titulo: shortTitle(fullTitle),
          tituloCompleto: fullTitle,
          Receita: Number(values.receita.toFixed(2)),
          Spend: Number(values.spend.toFixed(2)),
        };
      })
      .filter((row) => row.Receita > 0 || row.Spend > 0)
      .sort((a, b) => (b.Receita + b.Spend) - (a.Receita + a.Spend))
      .slice(0, 5);
  }, [state.products, state.campaigns, state.metrics]);

  if (state.loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl h-64 flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-cyan animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5" data-top-five-product-chart="true">
      <h2 className="text-sm font-semibold text-slate-300 mb-4">Receita & Spend por Produto (Top 5, 30d)</h2>
      {state.error || data.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-xs text-slate-500">
          {state.error || 'Sem dados de produtos.'}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 48, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis
              dataKey="titulo"
              interval={0}
              angle={-18}
              textAnchor="end"
              height={62}
              tick={{ fontSize: 9, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(value, name) => [brl(value), name]}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.tituloCompleto || ''}
              contentStyle={{ background: '#111318', border: '1px solid #252936', borderRadius: 8, fontSize: 11 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Receita" fill="#10B981" radius={[3, 3, 0, 0]} />
            <Bar dataKey="Spend" fill="#3B82F6" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
