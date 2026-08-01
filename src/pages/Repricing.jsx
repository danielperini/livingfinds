import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Search,
  Tag,
  Upload,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';

const money = value => Number.isFinite(Number(value))
  ? Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  : '—';

const brazilDay = (value = Date.now()) =>
  new Date(new Date(value).getTime() - 3 * 3600000).toISOString().slice(0, 10);

const time = value => value
  ? new Date(value).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  : '—';

const sourceLabel = source => {
  if (source === 'automatic_repricing') return 'Motor / IA';
  if (source === 'manual_suggested_price') return 'Aplicação manual';
  return source || 'Origem não registrada';
};

function percentChange(before, after) {
  const oldPrice = Number(before);
  const newPrice = Number(after);
  if (!(oldPrice > 0) || !Number.isFinite(newPrice)) return null;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

function Stat({ label, value, detail, tone = 'slate' }) {
  const tones = {
    slate: 'border-surface-2 bg-surface-1 text-slate-200',
    cyan: 'border-cyan/20 bg-cyan/5 text-cyan',
    green: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400',
    red: 'border-red-500/20 bg-red-500/5 text-red-400',
  };
  return <div className={`rounded-xl border p-4 ${tones[tone]}`}><p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 text-xl font-bold">{value}</p>{detail && <p className="mt-1 text-[10px] text-slate-500">{detail}</p>}</div>;
}

export default function Repricing() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [selectedDate, setSelectedDate] = useState(brazilDay());
  const [history, setHistory] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [connection, setConnection] = useState(null);
  const [importingCosts, setImportingCosts] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('all');
  const costFileRef = useRef(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await base44.auth.me();
        let rows = await base44.entities.AmazonAccount.filter({ user_id: me.id }).catch(() => []);
        if (!rows.length) rows = await base44.entities.AmazonAccount.filter({ status: 'connected' }).catch(() => []);
        if (!rows.length) rows = await base44.entities.AmazonAccount.list('-updated_date', 100).catch(() => []);
        if (!active) return;
        setAccounts(rows);
        setAccountId(rows[0]?.id || '');
        if (!rows.length) setLoading(false);
      } catch (loadError) {
        if (!active) return;
        setError(loadError?.message || 'Não foi possível carregar as contas Amazon.');
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError('');
    try {
      const [historyRows, productRows] = await Promise.all([
        base44.entities.ProductEconomicsHistory.filter(
          { amazon_account_id: accountId, history_type: 'price_confirmed' },
          '-changed_at',
          2000,
        ),
        base44.entities.Product.filter({ amazon_account_id: accountId }, '-updated_date', 5000),
      ]);
      setHistory(historyRows || []);
      setProducts(productRows || []);
    } catch (loadError) {
      setError(loadError?.message || 'Não foi possível carregar o histórico confirmado de preços.');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const checkAmazonConnection = async () => {
    if (!accountId) return;
    setCheckingConnection(true);
    setError('');
    try {
      const response = await base44.functions.invoke('runAutomaticRepricing', {
        operation: 'connection_check',
        amazon_account_id: accountId,
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao verificar a Amazon SP-API.');
      setConnection(result.results?.[0] || null);
    } catch (connectionError) {
      setConnection({ connected: false, message: connectionError?.message || 'Falha ao verificar a Amazon SP-API.' });
    } finally {
      setCheckingConnection(false);
    }
  };

  const importCostSpreadsheet = async event => {
    const file = event.target.files?.[0];
    if (!file || !accountId) return;
    setImportingCosts(true);
    setImportResult(null);
    setError('');
    try {
      const upload = await base44.integrations.Core.UploadFile({ file });
      const response = await base44.functions.invoke('importProductEconomics', {
        amazon_account_id: accountId,
        file_url: upload.file_url,
        enable_repricing_for_active: true,
        run_decision_engine: true,
        refresh_amazon_status: true,
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao importar custos.');
      setImportResult(result);
      await load();
    } catch (importError) {
      setError(importError?.message || 'Falha ao importar a planilha de custos.');
    } finally {
      setImportingCosts(false);
      if (costFileRef.current) costFileRef.current.value = '';
    }
  };

  const productIndex = useMemo(() => {
    const map = new Map();
    for (const product of products) {
      if (product.id) map.set(`id:${product.id}`, product);
      if (product.sku) map.set(`sku:${String(product.sku).trim().toUpperCase()}`, product);
      if (product.asin) map.set(`asin:${String(product.asin).trim().toUpperCase()}`, product);
    }
    return map;
  }, [products]);

  const rows = useMemo(() => {
    const seen = new Set();
    return history
    .filter(item => brazilDay(item.changed_at) === selectedDate)
    .filter(item => Number(item.price_before) > 0 && Number(item.price_after) > 0)
    .filter(item => Math.abs(Number(item.price_after) - Number(item.price_before)) >= 0.01)
    .filter(item => {
      const key = String(item.normalized_sku || item.sku || item.asin || item.product_id || item.id).trim().toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(item => {
      const product = productIndex.get(`id:${item.product_id}`) ||
        productIndex.get(`sku:${String(item.sku || '').trim().toUpperCase()}`) ||
        productIndex.get(`asin:${String(item.asin || '').trim().toUpperCase()}`) || {};
      return {
        ...item,
        title: product.display_name || product.product_name || product.title || 'Título não disponível no cadastro',
        percent: percentChange(item.price_before, item.price_after),
      };
    })
    .filter(item => source === 'all' || (source === 'automatic'
      ? item.source === 'automatic_repricing'
      : item.source !== 'automatic_repricing'))
    .filter(item => {
      const needle = search.trim().toLowerCase();
      if (!needle) return true;
      return [item.sku, item.asin, item.title].some(value => String(value || '').toLowerCase().includes(needle));
    });
  }, [history, productIndex, search, selectedDate, source]);

  const summary = useMemo(() => ({
    total: rows.length,
    increases: rows.filter(row => Number(row.percent) > 0).length,
    reductions: rows.filter(row => Number(row.percent) < 0).length,
    automatic: rows.filter(row => row.source === 'automatic_repricing').length,
  }), [rows]);

  return (
    <div className="min-h-full p-4 md:p-6 space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2"><Tag className="h-5 w-5 text-cyan" /><h1 className="text-xl font-bold text-white">Repricing</h1></div>
          <p className="mt-1 text-xs text-slate-500">Preços alterados e confirmados na Amazon. O painel não exibe recomendações ainda não publicadas.</p>
        </div>
        <div className="flex flex-wrap gap-2"><input ref={costFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={importCostSpreadsheet} className="hidden" /><button onClick={() => costFileRef.current?.click()} disabled={importingCosts || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-400 disabled:opacity-50">{importingCosts ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{importingCosts ? 'Importando e recalculando...' : 'Importar custos e executar motor'}</button><button onClick={checkAmazonConnection} disabled={checkingConnection || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-2 text-xs font-semibold text-cyan disabled:opacity-50">{checkingConnection ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}Testar conexão Amazon</button><button onClick={load} disabled={loading || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-surface-3 px-3 py-2 text-xs text-slate-300 hover:bg-surface-2 disabled:opacity-50">{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Atualizar painel</button></div>
      </div>

      {importResult && <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" /><div><h2 className="text-sm font-bold text-emerald-400">Custos importados e motor acionado</h2><p className="mt-1 text-xs text-slate-400">{importResult.active_updated || 0} ativos verificados pela Amazon · {importResult.inactive_updated || 0} inativos/sem estoque mantidos sem repricing · {importResult.unmatched || 0} SKUs não encontrados · {importResult.errors || 0} erros.</p><p className="mt-1 text-[10px] text-slate-500">Status e estoque foram atualizados pela FBA Inventory API. Listings Items confirma depois se cada oferta está ativa e comprável. Os custos também atualizaram os limites econômicos usados pelo motor de Ads.</p></div></div></section>}

      {connection && <section className={`rounded-xl border p-4 ${connection.connected ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}><div className="flex items-start gap-3">{connection.connected ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" /> : <Tag className="mt-0.5 h-5 w-5 text-red-400" />}<div className="min-w-0"><h2 className={`text-sm font-bold ${connection.connected ? 'text-emerald-400' : 'text-red-400'}`}>{connection.connected ? 'Repricing conectado à Amazon SP-API' : 'Conexão SP-API incompleta'}</h2><p className="mt-1 text-xs text-slate-400">{connection.message || (connection.connected ? 'OAuth, Listings Items e Product Pricing foram validados sem alterar preços.' : 'Confira os detalhes abaixo.')}</p>{connection.checks && <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">{Object.entries(connection.checks).map(([name, check]) => <div key={name} className="rounded-lg border border-surface-3 bg-surface-1/60 p-2"><p className="text-[10px] font-semibold uppercase text-slate-500">{name}</p><p className={`mt-1 text-[10px] ${check.ok ? 'text-emerald-400' : check.skipped ? 'text-amber-400' : 'text-red-400'}`}>{check.message}</p></div>)}</div>}</div></div></section>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Alterações no dia" value={summary.total} detail="Somente preços confirmados" tone="cyan" />
        <Stat label="Aumentos" value={summary.increases} detail="Percentual positivo" tone="green" />
        <Stat label="Reduções" value={summary.reductions} detail="Percentual negativo" tone="red" />
        <Stat label="Motor / IA" value={summary.automatic} detail="Decisões automáticas confirmadas" />
      </div>

      <section className="rounded-xl border border-surface-2 bg-surface-1">
        <div className="flex flex-col gap-3 border-b border-surface-2 p-4 xl:flex-row xl:items-center">
          <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-600" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar SKU, ASIN ou título" className="w-full rounded-lg border border-surface-3 bg-surface-2 py-2 pl-9 pr-3 text-xs text-slate-200 outline-none focus:border-cyan/40" /></div>
          <label className="flex items-center gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-slate-400"><CalendarDays className="h-4 w-4" /><input type="date" value={selectedDate} onChange={event => setSelectedDate(event.target.value)} className="bg-transparent text-slate-200 outline-none" /></label>
          <select value={accountId} onChange={event => setAccountId(event.target.value)} className="rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-slate-200">
            {accounts.map(account => <option key={account.id} value={account.id}>{account.seller_name || account.account_name || account.marketplace_id || account.id}</option>)}
          </select>
          <select value={source} onChange={event => setSource(event.target.value)} className="rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-slate-200">
            <option value="all">Todas as origens</option><option value="automatic">Motor / IA</option><option value="manual">Aplicação manual</option>
          </select>
        </div>

        {error && <div className="m-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
        {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-cyan" /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-surface-2 bg-surface-2/40 text-left text-[10px] uppercase tracking-wider text-slate-500">
                {['Horário', 'SKU', 'ASIN', 'Título', 'Valor anterior', 'Valor alterado', 'Alteração', 'Origem', 'Confirmação'].map(label => <th key={label} className="whitespace-nowrap px-4 py-3">{label}</th>)}
              </tr></thead>
              <tbody>{rows.map(row => {
                const positive = Number(row.percent) > 0;
                const negative = Number(row.percent) < 0;
                return <tr key={row.id} className="border-b border-surface-2/50 hover:bg-surface-2/30">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{time(row.changed_at)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-cyan">{row.sku || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{row.asin || '—'}</td>
                  <td className="min-w-[260px] max-w-[420px] px-4 py-3 text-slate-300"><p className="line-clamp-2">{row.title}</p></td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">{money(row.price_before)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-white">{money(row.price_after)}</td>
                  <td className={`whitespace-nowrap px-4 py-3 font-bold ${positive ? 'text-emerald-400' : negative ? 'text-red-400' : 'text-slate-500'}`}>
                    <span className="inline-flex items-center gap-1">{positive ? <ArrowUpRight className="h-3.5 w-3.5" /> : negative ? <ArrowDownRight className="h-3.5 w-3.5" /> : null}{row.percent == null ? '—' : `${row.percent > 0 ? '+' : ''}${row.percent.toFixed(2)}%`}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3"><span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] ${row.source === 'automatic_repricing' ? 'border-violet-500/20 bg-violet-500/10 text-violet-400' : 'border-surface-3 text-slate-400'}`}>{row.source === 'automatic_repricing' && <Bot className="h-3 w-3" />}{sourceLabel(row.source)}</span></td>
                  <td className="whitespace-nowrap px-4 py-3"><span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />Amazon confirmada</span></td>
                </tr>;
              })}</tbody>
            </table>
            {!rows.length && !error && <div className="py-16 text-center"><Tag className="mx-auto h-7 w-7 text-slate-700" /><p className="mt-3 text-sm text-slate-400">Nenhum preço confirmado nesta data.</p><p className="mt-1 text-xs text-slate-600">Recomendações e ações pendentes não são contabilizadas como alteração.</p></div>}
          </div>
        )}
      </section>
    </div>
  );
}
