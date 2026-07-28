import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Download, Loader2, ChevronDown } from 'lucide-react';

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(','))
  ].join('\n');
}

function downloadCSV(filename, content) {
  const bom = '\uFEFF'; // UTF-8 BOM para Excel reconhecer acentos
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const EXPORT_OPTIONS = [
  { key: 'campaigns', label: 'Campanhas (resumo atual)' },
  { key: 'metrics_daily', label: 'Métricas diárias (30 dias)' },
  { key: 'sales_daily', label: 'Vendas diárias (30 dias)' },
  { key: 'consolidated', label: 'Consolidado completo (tudo)' },
];

export default function ExportPerformanceButton({ account }) {
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const dateStr = new Date().toISOString().slice(0, 10);

  const exportCampaigns = async (accountId) => {
    const campaigns = await base44.entities.Campaign.filter(
      { amazon_account_id: accountId },
      '-spend',
      500
    );
    return campaigns
      .filter(c => (c.state || c.status || '') !== 'archived')
      .map(c => ({
        'Nome da Campanha': c.name || c.campaign_name || '',
        'ASIN': c.asin || '',
        'Tipo': c.targeting_type || '',
        'Status': c.state || c.status || '',
        'Orçamento Diário (R$)': c.daily_budget || 0,
        'Spend (R$)': (c.spend || 0).toFixed(2),
        'Vendas (R$)': (c.sales || 0).toFixed(2),
        'ACoS (%)': (c.acos || 0).toFixed(2),
        'ROAS': (c.roas || 0).toFixed(2),
        'Impressões': c.impressions || 0,
        'Cliques': c.clicks || 0,
        'Pedidos': c.orders || 0,
        'CPC (R$)': (c.cpc || 0).toFixed(2),
        'CTR (%)': (c.ctr || 0).toFixed(2),
        'Estratégia de Lance': c.bidding_strategy || '',
        'Criada pelo App': c.created_by_app ? 'Sim' : 'Não',
        'Última Sync': c.last_sync_at || '',
      }));
  };

  const exportMetricsDaily = async (accountId) => {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    const [metrics, campaigns] = await Promise.all([
      base44.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: accountId },
        '-date',
        2000
      ),
      base44.entities.Campaign.filter({ amazon_account_id: accountId }, null, 500),
    ]);

    const campMap = Object.fromEntries(campaigns.map(c => [c.campaign_id || c.id, c]));

    return metrics
      .filter(m => m.date >= sinceStr)
      .map(m => {
        const camp = campMap[m.campaign_id] || {};
        return {
          'Data': m.date,
          'ID Campanha': m.campaign_id,
          'Nome da Campanha': camp.name || camp.campaign_name || '',
          'ASIN': camp.asin || '',
          'Tipo': camp.targeting_type || '',
          'Impressões': m.impressions || 0,
          'Cliques': m.clicks || 0,
          'Spend (R$)': (m.spend || 0).toFixed(2),
          'Vendas (R$)': (m.sales || 0).toFixed(2),
          'Pedidos': m.orders || 0,
          'ACoS (%)': (m.acos || 0).toFixed(2),
          'ROAS': (m.roas || 0).toFixed(2),
          'CPC (R$)': (m.cpc || 0).toFixed(2),
          'CTR (%)': (m.ctr || 0).toFixed(2),
        };
      });
  };

  const exportSalesDaily = async (accountId) => {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    const sales = await base44.entities.SalesDaily.filter(
      { amazon_account_id: accountId },
      '-date',
      1000
    );

    return sales
      .filter(s => s.date >= sinceStr)
      .map(s => ({
        'Data': s.date,
        'ASIN': s.asin || '',
        'Unidades Vendidas': s.units_ordered || 0,
        'Receita Bruta (R$)': (s.ordered_product_sales || 0).toFixed(2),
        'Faturamento Bruto (R$)': (s.gross_revenue || 0).toFixed(2),
        'Receita Líquida (R$)': (s.net_revenue || 0).toFixed(2),
        'Taxas Amazon (R$)': (s.amazon_fees || 0).toFixed(2),
        'Taxa Referral (R$)': (s.referral_fee || 0).toFixed(2),
        'Taxa FBA (R$)': (s.fba_fee || 0).toFixed(2),
        'Gasto em Ads (R$)': (s.ads_spend || 0).toFixed(2),
        'Lucro Bruto (R$)': (s.gross_profit || 0).toFixed(2),
        'Lucro pós-Ads (R$)': (s.profit_after_ads || 0).toFixed(2),
        'Margem Bruta (%)': (s.gross_margin_pct || 0).toFixed(2),
        'TACoS (%)': s.ads_spend > 0 && s.gross_revenue > 0
          ? ((s.ads_spend / s.gross_revenue) * 100).toFixed(2)
          : '0.00',
        'Sessões': s.sessions || 0,
        'Taxa de Conversão (%)': (s.conversion_rate || 0).toFixed(2),
        'Buy Box (%)': (s.buy_box_pct || 0).toFixed(2),
      }));
  };

  const handleExport = async (key) => {
    if (!account || loading) return;
    setOpen(false);
    setLoading(true);
    try {
      if (key === 'campaigns') {
        const rows = await exportCampaigns(account.id);
        downloadCSV(`campanhas_${dateStr}.csv`, toCSV(rows));
      } else if (key === 'metrics_daily') {
        const rows = await exportMetricsDaily(account.id);
        downloadCSV(`metricas_diarias_${dateStr}.csv`, toCSV(rows));
      } else if (key === 'sales_daily') {
        const rows = await exportSalesDaily(account.id);
        downloadCSV(`vendas_diarias_${dateStr}.csv`, toCSV(rows));
      } else if (key === 'consolidated') {
        const [campRows, metricsRows, salesRows] = await Promise.all([
          exportCampaigns(account.id),
          exportMetricsDaily(account.id),
          exportSalesDaily(account.id),
        ]);
        // 3 abas em arquivos separados com prefixo comum
        const prefix = `export_${dateStr}`;
        downloadCSV(`${prefix}_campanhas.csv`, toCSV(campRows));
        await new Promise(r => setTimeout(r, 300));
        downloadCSV(`${prefix}_metricas_diarias.csv`, toCSV(metricsRows));
        await new Promise(r => setTimeout(r, 300));
        downloadCSV(`${prefix}_vendas_diarias.csv`, toCSV(salesRows));
      }
    } catch (e) {
      console.error('Erro ao exportar:', e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        disabled={!account || loading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white hover:border-slate-500 rounded-lg transition-colors disabled:opacity-50"
      >
        {loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Download className="w-3.5 h-3.5" />}
        Exportar
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-[#111827] border border-surface-2 rounded-xl shadow-2xl overflow-hidden">
            {EXPORT_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => handleExport(opt.key)}
                className="w-full text-left px-4 py-2.5 text-xs text-slate-300 hover:bg-surface-2 hover:text-white transition-colors flex items-center gap-2"
              >
                <Download className="w-3 h-3 text-slate-500 flex-shrink-0" />
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}