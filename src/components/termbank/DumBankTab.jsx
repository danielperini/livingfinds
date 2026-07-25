import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Zap, Loader2, RefreshCw, Share2, CheckCircle, Clock, AlertCircle, Package } from 'lucide-react';

const STOPWORDS = new Set([
  'de','do','da','dos','das','em','no','na','nos','nas','ao','aos','e','a','o',
  'os','as','um','uma','para','por','com','sem','que','se','mas','ou',
  'cm','mm','kg','g','led','pro','kit','set','novo','nova','preto','preta',
]);

function normalize(text) {
  return (text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalize(text).split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

function groupProductsByTitle(products) {
  const productTokens = products.map(p => ({
    ...p,
    tokens: new Set(tokenize(p.display_name || p.product_name || '')),
  }));
  const groups = [];
  const assigned = new Set();
  for (let i = 0; i < productTokens.length; i++) {
    if (assigned.has(productTokens[i].asin) || productTokens[i].tokens.size === 0) continue;
    const group = {
      products: [productTokens[i]],
      asins: [productTokens[i].asin],
      commonTokens: new Set(productTokens[i].tokens),
    };
    assigned.add(productTokens[i].asin);
    for (let j = i + 1; j < productTokens.length; j++) {
      if (assigned.has(productTokens[j].asin) || productTokens[j].tokens.size === 0) continue;
      let commonCount = 0;
      for (const t of productTokens[j].tokens) {
        if (group.commonTokens.has(t)) commonCount++;
      }
      if (commonCount >= 2) {
        group.products.push(productTokens[j]);
        group.asins.push(productTokens[j].asin);
        assigned.add(productTokens[j].asin);
        for (const t of [...group.commonTokens]) {
          if (!productTokens[j].tokens.has(t)) group.commonTokens.delete(t);
        }
      }
    }
    if (group.asins.length >= 2) {
      const nameParts = [...group.commonTokens].slice(0, 3).join(' ');
      groups.push({
        name: nameParts || group.products[0].product_name || 'Grupo',
        asins: group.asins,
        products: group.products,
      });
    }
  }
  return groups;
}

const STATUS_CONFIG = {
  PROPOSED:  { label: 'Proposta', color: 'text-slate-400', bg: 'bg-slate-500/15', icon: Clock },
  EXECUTING: { label: 'Executando', color: 'text-amber-400', bg: 'bg-amber-500/15', icon: Loader2 },
  EXECUTED:  { label: 'Executada', color: 'text-emerald-400', bg: 'bg-emerald-500/15', icon: CheckCircle },
  APPROVED:  { label: 'Aprovada', color: 'text-cyan-400', bg: 'bg-cyan/15', icon: CheckCircle },
  FAILED:    { label: 'Falhou', color: 'text-red-400', bg: 'bg-red-500/15', icon: AlertCircle },
  REJECTED:  { label: 'Rejeitada', color: 'text-red-400', bg: 'bg-red-500/15', icon: AlertCircle },
  VALIDATING:{ label: 'Validando', color: 'text-violet-400', bg: 'bg-violet-500/15', icon: Clock },
  PROVEN:    { label: 'Provada', color: 'text-emerald-400', bg: 'bg-emerald-500/15', icon: CheckCircle },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.PROPOSED;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${cfg.bg} ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

export default function DumBankTab({ account, search }) {
  const [transfers, setTransfers] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const [t, p] = await Promise.all([
        base44.entities.CrossAsinTransfer.filter({ amazon_account_id: account.id }, '-created_at', 200),
        base44.entities.Product.filter({ amazon_account_id: account.id }, null, 200),
      ]);
      setTransfers(t);
      setProducts(p.filter(p => p.status !== 'archived' && p.asin));
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [account?.id]);

  const handleRunNow = async () => {
    if (!account || running) return;
    setRunning(true);
    setMessage({ type: 'info', text: 'Executando motor cross-ASIN...' });
    try {
      const res = await base44.functions.invoke('runCrossAsinTransfer', {
        amazon_account_id: account.id,
        force: true,
      });
      const d = res?.data || {};
      if (d.ok) {
        setMessage({
          type: 'success',
          text: `✓ ${d.transfers_created} transferências criadas · ${d.groups_analyzed} grupos analisados · ${d.transfers_queued} campanhas enfileiradas`,
        });
        await load();
      } else {
        setMessage({ type: 'error', text: d.error || 'Erro ao executar' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
    }
  };

  // Agrupar produtos por heurística (mesmo algoritmo do backend)
  const groups = useMemo(() => groupProductsByTitle(products), [products]);

  // Mapear transferências por destination_asin+normalized_keyword
  const transferMap = useMemo(() => {
    const m = new Map();
    for (const t of transfers) {
      const nkw = (t.normalized_keyword || t.keyword || '').toLowerCase().trim();
      const key = `${t.source_asin}|${nkw}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(t);
    }
    return m;
  }, [transfers]);

  // Estatísticas globais
  const stats = useMemo(() => {
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const todayT = transfers.filter(t => (t.created_at || '').slice(0, 10) === today);
    return {
      total: transfers.length,
      executed: transfers.filter(t => ['EXECUTED', 'PROVEN'].includes(t.status)).length,
      queued: transfers.filter(t => ['PROPOSED', 'EXECUTING', 'APPROVED', 'VALIDATING'].includes(t.status)).length,
      failed: transfers.filter(t => ['FAILED', 'REJECTED'].includes(t.status)).length,
      today: todayT.length,
      groups: groups.length,
    };
  }, [transfers, groups]);

  const q = (search || '').toLowerCase();

  // Transferências filtradas por busca
  const filteredTransfers = useMemo(() => {
    if (!q) return transfers;
    return transfers.filter(t =>
      (t.keyword || '').toLowerCase().includes(q) ||
      (t.source_asin || '').toLowerCase().includes(q) ||
      (t.destination_asin || '').toLowerCase().includes(q) ||
      (t.destination_product_name || '').toLowerCase().includes(q) ||
      (t.product_family || '').toLowerCase().includes(q)
    );
  }, [transfers, q]);

  // Agrupar transferências por product_family
  const byFamily = useMemo(() => {
    const map = new Map();
    for (const t of filteredTransfers) {
      const family = t.product_family || 'Outros';
      if (!map.has(family)) map.set(family, []);
      map.get(family).push(t);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [filteredTransfers]);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header de ação */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-slate-500">
            Expande cobertura de keywords provadas entre produtos similares automaticamente
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading || running} className="p-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleRunNow}
            disabled={running}
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {running ? 'Executando...' : 'Executar Agora'}
          </button>
        </div>
      </div>

      {message && (
        <div className={`rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-emerald-400/10 text-emerald-300' : message.type === 'info' ? 'bg-amber-400/10 text-amber-300' : 'bg-red-400/10 text-red-300'}`}>
          {message.text}
        </div>
      )}

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Grupos Ativos', value: stats.groups, color: 'text-violet-400' },
          { label: 'Criadas Hoje', value: stats.today, color: 'text-cyan-400' },
          { label: 'Em Fila', value: stats.queued, color: 'text-amber-400' },
          { label: 'Executadas', value: stats.executed, color: 'text-emerald-400' },
          { label: 'Falharam', value: stats.failed, color: 'text-red-400' },
        ].map(s => (
          <div key={s.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4 text-center">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-[10px] text-slate-500 mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Grupos de produtos identificados */}
      {groups.length > 0 && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
            <Package className="w-4 h-4 text-violet-400" />
            Grupos de Produto Identificados
          </h3>
          <div className="flex flex-wrap gap-2">
            {groups.map((g, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-violet-500/10 border border-violet-500/20 rounded-lg">
                <Share2 className="w-3 h-3 text-violet-400" />
                <span className="text-xs text-violet-300 font-medium capitalize">{g.name}</span>
                <span className="text-[10px] text-slate-500">{g.asins.length} ASINs</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabela de transferências por família */}
      {filteredTransfers.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <Share2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">Nenhuma transferência encontrada</p>
          <p className="text-xs mt-1">Clique em "Executar Agora" para iniciar o motor cross-ASIN</p>
        </div>
      ) : (
        <div className="space-y-4">
          {byFamily.map(([family, familyTransfers]) => (
            <div key={family} className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-surface-2/50 border-b border-surface-2">
                <div className="flex items-center gap-2">
                  <Share2 className="w-4 h-4 text-violet-400" />
                  <span className="text-sm font-semibold text-white capitalize">{family}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-emerald-400">{familyTransfers.filter(t => ['EXECUTED','PROVEN'].includes(t.status)).length} executadas</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-amber-400">{familyTransfers.filter(t => ['PROPOSED','EXECUTING','APPROVED'].includes(t.status)).length} em fila</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400">{familyTransfers.length} total</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-surface-2">
                      <th className="px-4 py-2 text-left text-slate-500 font-medium">Keyword</th>
                      <th className="px-4 py-2 text-left text-slate-500 font-medium">ASIN Origem</th>
                      <th className="px-4 py-2 text-left text-slate-500 font-medium">Performance Origem</th>
                      <th className="px-4 py-2 text-left text-slate-500 font-medium">ASIN Receptor</th>
                      <th className="px-4 py-2 text-left text-slate-500 font-medium">Status</th>
                      <th className="px-4 py-2 text-left text-slate-500 font-medium">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {familyTransfers.map(t => (
                      <tr key={t.id} className="border-b border-surface-2/40 hover:bg-surface-2/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="font-semibold text-white">{t.keyword}</span>
                          {t.transfer_confidence === 'HIGH' && (
                            <span className="ml-1.5 text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1 py-0.5 rounded">alta</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-cyan-400">{t.source_asin}</td>
                        <td className="px-4 py-2.5">
                          {t.source_acos > 0 ? (
                            <span className={`${t.source_acos <= 15 ? 'text-emerald-400' : t.source_acos <= 25 ? 'text-amber-400' : 'text-red-400'}`}>
                              ACoS {Number(t.source_acos).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-slate-600">Conf. {t.relevance_score || 0}%</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-violet-400">{t.destination_asin}</span>
                          {t.destination_fba_inventory > 0 && (
                            <span className="ml-1.5 text-[9px] text-slate-500">{t.destination_fba_inventory} un</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="px-4 py-2.5 text-slate-500">
                          {t.created_at ? new Date(t.created_at).toLocaleDateString('pt-BR') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}