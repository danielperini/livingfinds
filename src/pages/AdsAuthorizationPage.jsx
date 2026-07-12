/**
 * Configurações → Produtos Autorizados para Ads
 * Controle estrutural de elegibilidade por SKU.
 */
import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Shield, ShieldAlert, ShieldOff, ShieldCheck, RefreshCw, Loader2,
  CheckCircle2, XCircle, AlertTriangle, Package, Megaphone, Clock,
  Eye, Pause, Play, Info
} from 'lucide-react';

const SCOPE_CONFIG = {
  authorized:             { label: 'Autorizado',            color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: ShieldCheck },
  not_authorized:         { label: 'Não autorizado',        color: 'text-slate-500',   bg: 'bg-slate-500/8 border-slate-500/15',      icon: ShieldOff },
  temporarily_ineligible: { label: 'Temp. inelegível',      color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',     icon: ShieldAlert },
  manual_block:           { label: 'Bloqueado manualmente', color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20',         icon: XCircle },
  mapping_conflict:       { label: 'Conflito SKU/ASIN',     color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/20',   icon: AlertTriangle },
};

const ELIGIBILITY_CONFIG = {
  eligible:           { label: 'Elegível',             color: 'text-emerald-400' },
  out_of_stock:       { label: 'Sem estoque',          color: 'text-amber-400' },
  low_stock:          { label: 'Estoque baixo',        color: 'text-yellow-400' },
  listing_suppressed: { label: 'Oferta suprimida',     color: 'text-red-400' },
  listing_inactive:   { label: 'Listing inativo',      color: 'text-red-400' },
  offer_inactive:     { label: 'Oferta inativa',       color: 'text-orange-400' },
  not_buyable:        { label: 'Não comprável',        color: 'text-red-400' },
  mapping_conflict:   { label: 'Conflito ASIN',        color: 'text-orange-400' },
  not_authorized:     { label: 'Não autorizado',       color: 'text-slate-500' },
  manual_block:       { label: 'Bloqueio manual',      color: 'text-red-400' },
  data_stale:         { label: 'Dados desatualizados', color: 'text-slate-400' },
  unknown:            { label: 'Desconhecido',         color: 'text-slate-500' },
};

function ScopeBadge({ status }) {
  const cfg = SCOPE_CONFIG[status] || SCOPE_CONFIG.not_authorized;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${cfg.bg} ${cfg.color}`}>
      <Icon className="w-2.5 h-2.5" />{cfg.label}
    </span>
  );
}

function EligibilityBadge({ status }) {
  const cfg = ELIGIBILITY_CONFIG[status] || ELIGIBILITY_CONFIG.unknown;
  return <span className={`text-[10px] font-semibold ${cfg.color}`}>{cfg.label}</span>;
}

export default function AdsAuthorizationPage() {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [dryRunResult, setDryRunResult] = useState(null);
  const [msg, setMsg] = useState(null);
  const [filterScope, setFilterScope] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accs[0];
      setAccount(acc);
      if (!acc) return;
      const [prods, camps] = await Promise.all([
        base44.entities.Product.filter({ amazon_account_id: acc.id }, null, 500),
        base44.entities.Campaign.filter({ amazon_account_id: acc.id }, null, 300),
      ]);
      setProducts(prods || []);
      setCampaigns(camps || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runDryRun = async () => {
    if (!account) return;
    setDryRunResult(null);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('applyAdsScopeAuthorization', {
        amazon_account_id: account.id, dry_run: true,
      });
      setDryRunResult(res?.data);
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
  };

  const applyScope = async () => {
    if (!account) return;
    if (!window.confirm('Aplicar autorização de escopo? Isso irá pausar campanhas de SKUs não autorizados na Amazon Ads API.')) return;
    setApplying(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('applyAdsScopeAuthorization', {
        amazon_account_id: account.id, dry_run: false,
      });
      const d = res?.data;
      if (d?.ok) {
        setMsg({ type: 'success', text: `Escopo aplicado: ${d.authorized_products?.length || 0} autorizados, ${d.campaigns_paused_on_amazon || 0} campanhas pausadas na Amazon, ${d.decisions_cancelled || 0} decisões canceladas.` });
        await load();
      } else {
        setMsg({ type: 'error', text: d?.error || 'Erro ao aplicar escopo' });
      }
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally {
      setApplying(false);
      setTimeout(() => setMsg(null), 15000);
    }
  };

  // Deduplicar por SKU
  const prodBySku = new Map();
  for (const p of products) {
    const sku = (p.sku || '').trim();
    if (!sku) continue;
    if (!prodBySku.has(sku)) prodBySku.set(sku, p);
  }
  const uniqueProds = Array.from(prodBySku.values());

  const campByAsin = new Map();
  for (const c of campaigns) {
    if (!c.asin) continue;
    if (!campByAsin.has(c.asin)) campByAsin.set(c.asin, []);
    campByAsin.get(c.asin).push(c);
  }

  const filtered = uniqueProds.filter(p => filterScope === 'all' || p.ads_scope_status === filterScope);

  const stats = {
    authorized:     uniqueProds.filter(p => p.ads_scope_status === 'authorized').length,
    eligible:       uniqueProds.filter(p => p.ads_eligibility_status === 'eligible').length,
    ineligible:     uniqueProds.filter(p => p.ads_scope_status === 'authorized' && p.ads_eligibility_status !== 'eligible' && p.ads_eligibility_status !== 'unknown').length,
    not_authorized: uniqueProds.filter(p => p.ads_scope_status === 'not_authorized').length,
    conflicts:      uniqueProds.filter(p => p.ads_scope_status === 'mapping_conflict').length,
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-emerald-400" />
            Produtos Autorizados para Ads
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">Controle estrutural de elegibilidade por SKU — base do motor de decisões</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={runDryRun} disabled={!account || applying}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg disabled:opacity-50 transition-colors">
            <Eye className="w-3.5 h-3.5" /> Simular
          </button>
          <button onClick={applyScope} disabled={!account || applying}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 rounded-lg disabled:opacity-50 transition-colors">
            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            Aplicar Escopo
          </button>
          <button onClick={load} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg disabled:opacity-50 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {msg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}`}>
          {msg.text}
        </div>
      )}

      {dryRunResult && (
        <div className="p-4 rounded-xl border border-amber-500/25 bg-amber-500/5 space-y-2">
          <p className="text-xs font-bold text-amber-300 mb-2">Simulação — nenhuma alteração aplicada</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div><span className="text-slate-400">Autorizados:</span> <span className="font-semibold text-white">{dryRunResult.authorized_products?.length || 0}</span></div>
            <div><span className="text-slate-400">Não autorizados:</span> <span className="font-semibold text-white">{dryRunResult.not_authorized_products?.length || 0}</span></div>
            <div><span className="text-slate-400">Campanhas a pausar:</span> <span className="font-semibold text-amber-400">{dryRunResult.campaigns_to_pause?.length || 0}</span></div>
            <div><span className="text-slate-400">Conflitos ASIN:</span> <span className="font-semibold text-orange-400">{dryRunResult.mapping_conflicts?.length || 0}</span></div>
          </div>
          {(dryRunResult.campaigns_to_pause || []).length > 0 && (
            <div className="mt-2 space-y-0.5">
              <p className="text-[10px] text-slate-500">Campanhas que seriam pausadas:</p>
              {(dryRunResult.campaigns_to_pause || []).map((c, i) => (
                <div key={i} className="text-[10px] text-slate-400">• {c.name} — {c.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Autorizados',     value: stats.authorized,     color: 'text-emerald-400' },
          { label: 'Elegíveis',       value: stats.eligible,       color: 'text-cyan' },
          { label: 'Temp. Inelegíveis', value: stats.ineligible,   color: 'text-amber-400' },
          { label: 'Não autorizados', value: stats.not_authorized, color: 'text-slate-500' },
          { label: 'Conflitos ASIN',  value: stats.conflicts,      color: 'text-orange-400' },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3 text-center">
            <p className="text-[10px] text-slate-500 mb-1">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {[
          { key: 'all',             label: 'Todos' },
          { key: 'authorized',      label: 'Autorizados' },
          { key: 'not_authorized',  label: 'Não autorizados' },
          { key: 'mapping_conflict',label: 'Conflitos' },
          { key: 'manual_block',    label: 'Bloqueados' },
        ].map(f => (
          <button key={f.key} onClick={() => setFilterScope(f.key)}
            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${filterScope === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Tabela */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['SKU', 'ASIN', 'Produto', 'Estoque disp.', 'Listing', 'Autorização', 'Elegibilidade', 'Motivo', 'Campanhas', 'Retomada', 'Último check'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(product => {
                  const camps = campByAsin.get(product.asin) || [];
                  const activeCamps = camps.filter(c => ['enabled', 'ENABLED'].includes(c.state || c.status || ''));
                  const pausedCamps = camps.filter(c => ['paused', 'PAUSED'].includes(c.state || c.status || ''));
                  return (
                    <tr key={product.id} className="border-b border-surface-2/30 hover:bg-surface-2/20 transition-colors">
                      <td className="px-3 py-2.5 font-mono text-xs font-bold text-slate-200">{product.sku || '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-cyan">{product.asin}</td>
                      <td className="px-3 py-2.5 max-w-[150px]">
                        <p className="text-slate-300 truncate text-[11px]">{product.display_name || product.product_name || '—'}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`font-semibold ${(product.available_quantity || 0) > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {product.available_quantity ?? product.fba_inventory ?? 0}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {product.listing_suppressed
                          ? <span className="text-red-400 text-[10px] font-semibold">Suprimido</span>
                          : product.listing_buyable === false
                            ? <span className="text-orange-400 text-[10px]">Inativo</span>
                            : <span className="text-emerald-400 text-[10px]">Ativo</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <ScopeBadge status={product.ads_scope_status || 'not_authorized'} />
                      </td>
                      <td className="px-3 py-2.5">
                        <EligibilityBadge status={product.ads_eligibility_status || 'unknown'} />
                      </td>
                      <td className="px-3 py-2.5 max-w-[180px]">
                        <p className="text-[10px] text-slate-500 truncate" title={product.ads_ineligibility_reason}>
                          {product.ads_ineligibility_reason || '—'}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          {activeCamps.length > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400">
                              <Play className="w-2.5 h-2.5" />{activeCamps.length}
                            </span>
                          )}
                          {pausedCamps.length > 0 && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-400 ml-1">
                              <Pause className="w-2.5 h-2.5" />{pausedCamps.length}
                            </span>
                          )}
                          {activeCamps.length === 0 && pausedCamps.length === 0 && <span className="text-slate-600">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {product.ads_resume_pending
                          ? <span className="text-[10px] text-cyan font-semibold">Pendente</span>
                          : <span className="text-slate-600 text-[10px]">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {product.ads_last_eligibility_check_at
                          ? <span className="text-[10px] text-slate-500">{new Date(product.ads_last_eligibility_check_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          : <span className="text-slate-600 text-[10px]">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="p-4 rounded-xl border border-surface-2 bg-surface-1 text-xs text-slate-400 space-y-1">
        <p className="font-semibold text-slate-300 mb-2">Regras de elegibilidade</p>
        <p>• Ads ativos somente quando: <strong className="text-white">Autorização = Autorizado</strong> E <strong className="text-white">Elegibilidade = Elegível</strong></p>
        <p>• <strong className="text-amber-400">Estoque inbound</strong> não conta — apenas available_quantity &gt; 0</p>
        <p>• Campanhas pausadas por estoque/listing retomadas automaticamente quando condição melhora</p>
        <p>• Campanhas pausadas manualmente ou por desempenho não são retomadas pelo sistema</p>
        <p>• SKU fora da lista: campanhas pausadas, kickoff cancelado, decisões pendentes canceladas — estrutura preservada</p>
      </div>
    </div>
  );
}