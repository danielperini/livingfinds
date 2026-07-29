import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import {
  ChevronDown, ChevronRight, HelpCircle, ChevronUp,
  Loader2, Filter, Clock, TrendingUp, TrendingDown,
  AlertTriangle, CheckCircle, Zap, Package, Eye, EyeOff, ArrowUpDown
} from 'lucide-react';

// ─── Classificação do Motor ───────────────────────────────────────────────────

const MOTOR_STATUS = {
  OTIMIZANDO:  { label: 'OTIMIZANDO',  color: 'text-cyan',        bg: 'bg-cyan/15 border-cyan/30',            dot: 'bg-cyan animate-pulse',         desc: 'Motor ajustou bid nos últimos 2 dias — campanha em otimização ativa.' },
  PROTEGIDO:   { label: 'PROTEGIDO',   color: 'text-emerald-400', bg: 'bg-emerald-500/12 border-emerald-500/25', dot: 'bg-emerald-400',              desc: 'ACoS abaixo da meta — motor preserva o status atual sem reduzir.' },
  ALERTA:      { label: 'ALERTA',      color: 'text-red-400',     bg: 'bg-red-500/12 border-red-500/25',       dot: 'bg-red-400 animate-pulse',      desc: 'ACoS acima do máximo — motor reduzindo bids ou aguardando avaliação.' },
  BLOQUEADO:   { label: 'BLOQUEADO',   color: 'text-orange-400',  bg: 'bg-orange-500/12 border-orange-500/25', dot: 'bg-orange-400',                 desc: 'Sem estoque ou campanha pausada por sistema — motor não age até repor.' },
  MONITORANDO: { label: 'MONITORANDO', color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',  dot: 'bg-amber-400',                  desc: 'Dados insuficientes — motor acumulando cliques e conversões antes de agir.' },
  IGNORADO:    { label: 'IGNORADO',    color: 'text-slate-500',   bg: 'bg-slate-500/8 border-slate-500/15',   dot: 'bg-slate-500',                  desc: 'Nenhuma campanha vinculada a este produto — motor não tem atuação.' },
};

const MIN_CLICKS_THRESHOLD = 10;
const DECISION_RECENCY_MS = 2 * 24 * 60 * 60 * 1000; // 2 dias

function classifyMotorStatus({ product, campaign, lastDecision, activeAlert, metrics }) {
  // Sem campanha
  if (!campaign) return 'IGNORADO';

  const campaignState = (campaign.state || campaign.status || '').toLowerCase();
  const inventoryStatus = product?.inventory_status || 'unknown';

  // Bloqueado: sem estoque ou pausa por estoque
  if (inventoryStatus === 'out_of_stock') return 'BLOQUEADO';
  if (campaignState === 'paused') {
    const isStockPause = lastDecision?.decision_type === 'pause' &&
      (lastDecision?.rationale || '').toLowerCase().includes('estoque');
    if (isStockPause || inventoryStatus === 'out_of_stock') return 'BLOQUEADO';
    return 'BLOQUEADO'; // qualquer pausa → bloqueado para fins visuais
  }

  // Alerta: high_acos ativo
  if (activeAlert && activeAlert.alert_type === 'high_acos') return 'ALERTA';

  // Otimizando: bid_adjustment nos últimos 2 dias
  if (lastDecision && lastDecision.decision_type === 'bid_adjustment') {
    const decidedAt = new Date(lastDecision.evaluated_at || lastDecision.created_at || 0).getTime();
    if (Date.now() - decidedAt < DECISION_RECENCY_MS) return 'OTIMIZANDO';
  }

  // Protegido: ACoS abaixo da meta e sem redução recente
  const acos = metrics?.acos || 0;
  const targetAcos = metrics?.target_acos || 0;
  if (acos > 0 && targetAcos > 0 && acos <= targetAcos) return 'PROTEGIDO';

  // Monitorando: poucos cliques
  const clicks = metrics?.clicks || 0;
  if (clicks < MIN_CLICKS_THRESHOLD) return 'MONITORANDO';

  // Default: monitorando
  return 'MONITORANDO';
}

function fmtBRL(v) {
  return `R$${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateBR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function timeSince(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  if (h >= 48) return `${Math.floor(h / 24)}d atrás`;
  if (h >= 1) return `${h}h ${m}min atrás`;
  return `${m}min atrás`;
}

function timeUntil(iso) {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return 'disponível';
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  if (h >= 24) return `em ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `em ${h}h ${m}min`;
  return `em ${m}min`;
}

// ─── Linha expandível ─────────────────────────────────────────────────────────

function SkuRow({ row, targetAcos }) {
  const [open, setOpen] = useState(false);
  const status = row.motorStatus;
  const cfg = MOTOR_STATUS[status];

  return (
    <>
      <tr
        onClick={() => setOpen(v => !v)}
        className="border-b border-surface-2/50 hover:bg-surface-2/30 cursor-pointer transition-colors"
      >
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="w-3 h-3 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-500 flex-shrink-0" />}
            <div>
              <p className="text-xs font-mono font-bold text-cyan">{row.asin}</p>
              {row.sku ? <p className="text-[10px] text-slate-500">SKU: {row.sku}</p> : null}
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5 text-xs text-slate-400 max-w-[140px] truncate hidden sm:table-cell">
          {row.product_name ? row.product_name.slice(0, 40) : '—'}
        </td>
        <td className="px-3 py-2.5">
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded-full border ${cfg.bg} ${cfg.color}`}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
            {cfg.label}
          </span>
        </td>
        <td className="px-3 py-2.5 text-xs text-slate-300 text-right">{fmtBRL(row.spend)}</td>
        <td className="px-3 py-2.5 text-right">
          <span className={`text-xs font-semibold ${row.acos > (row.max_acos || 40) ? 'text-red-400' : row.acos > (targetAcos || 25) ? 'text-amber-400' : row.acos > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
            {row.acos > 0 ? `${row.acos.toFixed(1)}%` : '—'}
          </span>
        </td>
        <td className="px-3 py-2.5 text-xs text-slate-400 text-right hidden md:table-cell">
          {row.roas > 0 ? `${row.roas.toFixed(2)}x` : '—'}
        </td>
        <td className="px-3 py-2.5 text-xs text-emerald-400 text-right hidden md:table-cell">{fmtBRL(row.sales)}</td>
        <td className="px-3 py-2.5 text-xs text-slate-400 text-right hidden lg:table-cell">
          {row.clicks > 0 ? row.clicks.toLocaleString('pt-BR') : '—'}
        </td>
        <td className="px-3 py-2.5 text-[10px] text-slate-500 hidden xl:table-cell">
          {row.lastDecision ? timeSince(row.lastDecision.evaluated_at || row.lastDecision.created_at) : '—'}
        </td>
      </tr>

      {open ? (
        <tr className="border-b border-surface-2/50 bg-surface-1/50">
          <td colSpan={9} className="px-4 py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* Última decisão */}
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Última Ação do Motor</p>
                {row.lastDecision ? (
                  <div className="bg-surface-2 rounded-lg p-3 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-cyan">{row.lastDecision.decision_type}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        row.lastDecision.status === 'executed' ? 'bg-emerald-500/15 text-emerald-400' :
                        row.lastDecision.status === 'failed' ? 'bg-red-500/15 text-red-400' :
                        'bg-amber-500/15 text-amber-400'
                      }`}>{row.lastDecision.status}</span>
                      <span className="text-[10px] text-slate-500">{fmtDateBR(row.lastDecision.evaluated_at || row.lastDecision.created_at)}</span>
                    </div>
                    {row.lastDecision.rationale ? (
                      <p className="text-[11px] text-slate-300 leading-relaxed">{row.lastDecision.rationale.slice(0, 300)}{row.lastDecision.rationale.length > 300 ? '…' : ''}</p>
                    ) : null}
                    {(row.lastDecision.current_value != null || row.lastDecision.proposed_value != null) ? (
                      <div className="flex items-center gap-3 text-[10px]">
                        <span className="text-slate-500">Bid: <span className="text-white">{fmtBRL(row.lastDecision.current_value)}</span></span>
                        <span className="text-slate-600">→</span>
                        <span className="text-cyan font-semibold">{fmtBRL(row.lastDecision.proposed_value)}</span>
                        {row.lastDecision.expected_impact_pct != null ? (
                          <span className={`font-semibold ${row.lastDecision.expected_impact_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {row.lastDecision.expected_impact_pct > 0 ? '+' : ''}{row.lastDecision.expected_impact_pct.toFixed(1)}%
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {row.lastDecision.source_function ? (
                      <p className="text-[9px] text-slate-600">Motor: {row.lastDecision.source_function}</p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500 bg-surface-2 rounded-lg px-3 py-2">Nenhuma decisão registrada ainda.</p>
                )}

                {/* Cooldown */}
                {row.lastDecision?.cooldown_until && new Date(row.lastDecision.cooldown_until) > new Date() ? (
                  <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/8 border border-amber-500/20 rounded-lg">
                    <Clock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                    <p className="text-[10px] text-amber-300">
                      Próxima ação: <strong>{timeUntil(row.lastDecision.cooldown_until)}</strong>
                      <span className="text-slate-500 ml-1">(cooldown ativo)</span>
                    </p>
                  </div>
                ) : null}
              </div>

              {/* Métricas e status */}
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Dados Usados pelo Motor</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'ACoS atual', value: row.acos > 0 ? `${row.acos.toFixed(1)}%` : '—', color: row.acos > (row.max_acos || 40) ? 'text-red-400' : row.acos > (targetAcos || 25) ? 'text-amber-400' : 'text-emerald-400' },
                    { label: 'Meta ACoS', value: targetAcos > 0 ? `${targetAcos}%` : '—', color: 'text-slate-300' },
                    { label: 'Spend', value: fmtBRL(row.spend), color: 'text-cyan' },
                    { label: 'Vendas', value: fmtBRL(row.sales), color: 'text-emerald-400' },
                    { label: 'Cliques', value: row.clicks > 0 ? row.clicks.toLocaleString('pt-BR') : '—', color: 'text-slate-300' },
                    { label: 'Pedidos', value: row.orders > 0 ? row.orders.toString() : '—', color: 'text-slate-300' },
                    { label: 'ROAS', value: row.roas > 0 ? `${row.roas.toFixed(2)}x` : '—', color: 'text-slate-300' },
                    { label: 'CPC médio', value: row.cpc > 0 ? fmtBRL(row.cpc) : '—', color: 'text-slate-300' },
                  ].map(m => (
                    <div key={m.label} className="bg-surface-2 rounded p-2">
                      <p className="text-[9px] text-slate-500 mb-0.5">{m.label}</p>
                      <p className={`text-xs font-bold ${m.color}`}>{m.value}</p>
                    </div>
                  ))}
                </div>

                {/* Estado da campanha */}
                {row.campaign ? (
                  <div className="flex items-center gap-2 text-[10px] text-slate-400 bg-surface-2 rounded-lg px-3 py-2">
                    <span>Campanha:</span>
                    <span className="text-slate-300 font-medium truncate">{(row.campaign.name || row.campaign.campaign_name || row.campaign.campaign_id || '—').slice(0, 35)}</span>
                    <span className={`ml-auto flex-shrink-0 font-semibold ${
                      (row.campaign.state || row.campaign.status) === 'enabled' ? 'text-emerald-400' :
                      (row.campaign.state || row.campaign.status) === 'paused' ? 'text-amber-400' : 'text-slate-500'
                    }`}>{row.campaign.state || row.campaign.status || '—'}</span>
                  </div>
                ) : null}

                {/* Alerta ativo */}
                {row.activeAlert ? (
                  <div className="flex items-start gap-2 px-3 py-2 bg-red-500/8 border border-red-500/20 rounded-lg">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] font-semibold text-red-300">{row.activeAlert.title}</p>
                      <p className="text-[10px] text-red-400/80">{row.activeAlert.message?.slice(0, 100)}</p>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ─── Legenda ─────────────────────────────────────────────────────────────────

function Legend({ open, onToggle }) {
  return (
    <div className="border border-surface-2 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-3 bg-surface-1 hover:bg-surface-2/50 transition-colors text-left"
      >
        <HelpCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />
        <span className="text-xs font-semibold text-slate-400">O que cada status significa?</span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-500 ml-auto" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500 ml-auto" />}
      </button>
      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 p-4 bg-surface-1/50">
          {Object.entries(MOTOR_STATUS).map(([key, cfg]) => (
            <div key={key} className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg border ${cfg.bg}`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${cfg.dot.replace(' animate-pulse', '')}`} />
              <div>
                <p className={`text-[10px] font-bold ${cfg.color}`}>{cfg.label}</p>
                <p className="text-[10px] text-slate-400 leading-relaxed mt-0.5">{cfg.desc}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

const PAGE_SIZE = 10;

const SORT_COLUMNS = [
  { key: 'asin', label: 'ASIN / SKU', value: row => row.asin || row.sku || '' },
  { key: 'product', label: 'Produto', value: row => row.product_name || '' },
  { key: 'motor', label: 'Motor / IA', value: row => row.motorStatus || '' },
  { key: 'spend', label: 'Custo', value: row => row.spend },
  { key: 'acos', label: 'ACoS', value: row => row.acos },
  { key: 'roas', label: 'ROAS', value: row => row.roas },
  { key: 'sales', label: 'Vendas', value: row => row.sales },
  { key: 'clicks', label: 'Cliques', value: row => row.clicks },
  {
    key: 'last_action',
    label: 'Última ação',
    value: row => {
      const date = row.lastDecision?.evaluated_at || row.lastDecision?.created_at;
      return date ? new Date(date).getTime() : null;
    },
  },
];

export default function MotorStatusBySku({ accountId, targetAcos = 0 }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [legendOpen, setLegendOpen] = useState(false);
  const [filter, setFilter] = useState('all'); // all | ALERTA | BLOQUEADO | OTIMIZANDO | PROTEGIDO | MONITORANDO | IGNORADO
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: null, direction: 'asc' });

  useEffect(() => {
    if (!accountId) return;

    const load = async () => {
      setLoading(true);
      try {
        const [products, campaigns, decisions, alerts, metrics] = await Promise.all([
          base44.entities.Product.filter({ amazon_account_id: accountId, status: 'active' }, null, 500).catch(() => []),
          base44.entities.Campaign.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
          base44.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-evaluated_at', 500).catch(() => []),
          base44.entities.Alert.filter({ amazon_account_id: accountId, status: 'active' }, null, 200).catch(() => []),
          base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 1500).catch(() => []),
        ]);

        // Última decisão por ASIN
        const lastDecisionByAsin = {};
        for (const d of decisions) {
          if (!d.asin) continue;
          if (!lastDecisionByAsin[d.asin] ||
            new Date(d.evaluated_at || d.created_at) > new Date(lastDecisionByAsin[d.asin].evaluated_at || lastDecisionByAsin[d.asin].created_at)) {
            lastDecisionByAsin[d.asin] = d;
          }
        }

        // Alerta ativo por ASIN
        const alertByAsin = {};
        for (const a of alerts) {
          if (a.asin) alertByAsin[a.asin] = a;
        }

        // Campanha por ASIN (priorizar enabled, maior spend)
        const campaignByAsin = {};
        for (const c of campaigns) {
          if (!c.asin) continue;
          const existing = campaignByAsin[c.asin];
          if (!existing) { campaignByAsin[c.asin] = c; continue; }
          const stateA = (c.state || c.status || '').toLowerCase();
          const stateB = (existing.state || existing.status || '').toLowerCase();
          if (stateA === 'enabled' && stateB !== 'enabled') { campaignByAsin[c.asin] = c; continue; }
          if (stateA !== 'enabled' && stateB === 'enabled') continue;
          if ((c.spend || 0) > (existing.spend || 0)) campaignByAsin[c.asin] = c;
        }

        // Métricas agregadas por ASIN (últimos 15 dias)
        const cutoff = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
        const metricsByAsin = {};
        for (const m of metrics) {
          if (!m.date || m.date < cutoff) continue;
          // Encontrar ASIN via campaign
          const camp = campaigns.find(c => c.campaign_id === m.campaign_id || c.amazon_campaign_id === m.campaign_id);
          const asin = camp?.asin || m.asin;
          if (!asin) continue;
          if (!metricsByAsin[asin]) metricsByAsin[asin] = { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 };
          metricsByAsin[asin].spend += m.spend || 0;
          metricsByAsin[asin].sales += m.sales || 0;
          metricsByAsin[asin].clicks += m.clicks || 0;
          metricsByAsin[asin].orders += m.orders || 0;
          metricsByAsin[asin].impressions += m.impressions || 0;
        }

        // Montar linhas
        const built = products.map(p => {
          const asin = p.asin;
          const m = metricsByAsin[asin] || {};
          const spend = m.spend || (campaignByAsin[asin]?.spend || 0);
          const sales = m.sales || (campaignByAsin[asin]?.sales || 0);
          const clicks = m.clicks || (campaignByAsin[asin]?.clicks || 0);
          const orders = m.orders || (campaignByAsin[asin]?.orders || 0);
          const acos = sales > 0 ? (spend / sales) * 100 : 0;
          const roas = spend > 0 ? sales / spend : 0;
          const cpc = clicks > 0 ? spend / clicks : 0;

          const motorStatus = classifyMotorStatus({
            product: p,
            campaign: campaignByAsin[asin] || null,
            lastDecision: lastDecisionByAsin[asin] || null,
            activeAlert: alertByAsin[asin] || null,
            metrics: { acos, clicks, target_acos: targetAcos },
          });

          return {
            asin,
            sku: p.sku,
            product_name: p.product_name || p.display_name,
            spend, sales, clicks, orders, acos, roas, cpc,
            max_acos: p.max_acos || 0,
            motorStatus,
            campaign: campaignByAsin[asin] || null,
            lastDecision: lastDecisionByAsin[asin] || null,
            activeAlert: alertByAsin[asin] || null,
          };
        });

        // Ordenar: ALERTA > BLOQUEADO > OTIMIZANDO > PROTEGIDO > MONITORANDO > IGNORADO
        const ORDER = ['ALERTA', 'BLOQUEADO', 'OTIMIZANDO', 'PROTEGIDO', 'MONITORANDO', 'IGNORADO'];
        built.sort((a, b) => ORDER.indexOf(a.motorStatus) - ORDER.indexOf(b.motorStatus));

        setRows(built);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [accountId, targetAcos]);

  const filtered = useMemo(() => {
    const result = filter === 'all' ? [...rows] : rows.filter(r => r.motorStatus === filter);
    if (!sort.key) return result;
    const column = SORT_COLUMNS.find(item => item.key === sort.key);
    if (!column) return result;
    return result.sort((a, b) => {
      const aValue = column.value(a);
      const bValue = column.value(b);
      const aMissing = aValue === null || aValue === undefined || aValue === '';
      const bMissing = bValue === null || bValue === undefined || bValue === '';
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing && bMissing) return 0;
      const comparison = typeof aValue === 'number' && typeof bValue === 'number'
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), 'pt-BR', { numeric: true, sensitivity: 'base' });
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [rows, filter, sort]);

  const toggleSort = (key) => {
    setSort(current => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
    setPage(1);
  };

  const paginated = useMemo(() =>
    filtered.slice(0, page * PAGE_SIZE),
    [filtered, page]
  );

  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.motorStatus] = (c[r.motorStatus] || 0) + 1;
    return c;
  }, [rows]);

  const hasMore = paginated.length < filtered.length;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-300">Motor & IA — Status por Produto</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">O que o sistema está fazendo com cada SKU · últimos 15 dias</p>
          </div>
          {loading ? <Loader2 className="w-4 h-4 text-cyan animate-spin" /> : (
            <span className="text-[10px] text-slate-500">{rows.length} produto{rows.length !== 1 ? 's' : ''}</span>
          )}
        </div>

        {/* Filtros rápidos */}
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => { setFilter('all'); setPage(1); }}
            className={`px-2.5 py-1 text-[10px] font-semibold rounded-full border transition-colors ${filter === 'all' ? 'bg-slate-500/20 border-slate-500/30 text-slate-200' : 'border-surface-3 text-slate-500 hover:text-slate-300'}`}>
            Todos ({rows.length})
          </button>
          {Object.entries(MOTOR_STATUS).map(([key, cfg]) => {
            const count = counts[key] || 0;
            if (count === 0) return null;
            return (
              <button key={key} onClick={() => { setFilter(key); setPage(1); }}
                className={`px-2.5 py-1 text-[10px] font-semibold rounded-full border transition-colors ${filter === key ? `${cfg.bg} ${cfg.color}` : `border-surface-3 text-slate-500 hover:${cfg.color}`}`}>
                {cfg.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Legenda */}
      <div className="px-5 py-2 border-b border-surface-2">
        <Legend open={legendOpen} onToggle={() => setLegendOpen(v => !v)} />
      </div>

      {/* Tabela */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-cyan animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-500">
          {filter === 'all' ? 'Nenhum produto ativo encontrado.' : `Nenhum produto com status "${filter}".`}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-1/80">
                {SORT_COLUMNS.map((column, i) => {
                  const active = sort.key === column.key;
                  const SortIcon = active
                    ? (sort.direction === 'asc' ? ChevronUp : ChevronDown)
                    : ArrowUpDown;
                  return (
                  <th key={column.key} className={`px-3 py-2.5 text-left whitespace-nowrap ${
                    i === 1 ? 'hidden sm:table-cell' :
                    i === 5 || i === 6 ? 'hidden md:table-cell' :
                    i === 7 ? 'hidden lg:table-cell' :
                    i === 8 ? 'hidden xl:table-cell text-left' :
                    i >= 3 ? 'text-right' : ''
                  }`}>
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                        active ? 'text-cyan' : 'text-slate-500 hover:text-slate-300'
                      }`}
                      aria-label={`Ordenar por ${column.label}`}
                    >
                      {column.label}
                      <SortIcon className="w-3 h-3" />
                    </button>
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {paginated.map(row => (
                <SkuRow key={row.asin} row={row} targetAcos={targetAcos} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="px-5 py-3 border-t border-surface-2 text-center">
          <button onClick={() => setPage(p => p + 1)}
            className="text-[10px] text-cyan hover:underline">
            Carregar mais ({filtered.length - paginated.length} restantes)
          </button>
        </div>
      )}
    </div>
  );
}
