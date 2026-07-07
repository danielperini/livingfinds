import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, RefreshCw, Loader2, Sparkles, CheckCircle, XCircle,
  FlaskConical, AlertTriangle, TrendingUp, Target, Zap,
  ChevronDown, ChevronRight, BarChart2, Filter
} from 'lucide-react';

const fmt = (v, d = 2) => Number(v || 0).toFixed(d).replace('.', ',');
const pct = (v) => `${(Number(v || 0) * 100).toFixed(0)}%`;

const STATUS_CONFIG = {
  scored:       { label: 'Pontuada',      color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  candidate:    { label: 'Candidata',     color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  experimental: { label: 'Experimental',  color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  approved:     { label: 'Aprovada',      color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  created:      { label: 'Criada',        color: 'text-cyan bg-cyan/10 border-cyan/20' },
  monitoring:   { label: 'Monitorando',   color: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
  successful:   { label: 'Sucesso ✓',     color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  underperforming: { label: 'Abaixo',     color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  rejected:     { label: 'Rejeitada',     color: 'text-slate-500 bg-slate-500/10 border-slate-400/20' },
  blocked:      { label: 'Bloqueada',     color: 'text-red-500 bg-red-500/10 border-red-400/20' },
};

const TAIL_CONFIG = {
  long:   { label: 'Cauda Longa',  color: 'text-blue-400 bg-blue-500/15 border-blue-500/25' },
  medium: { label: 'Cauda Média',  color: 'text-amber-400 bg-amber-500/15 border-amber-500/25' },
  short:  { label: 'Cauda Curta',  color: 'text-slate-400 bg-slate-500/15 border-slate-500/25' },
};

const MATCH_COLOR = {
  EXACT:  'text-emerald-400',
  PHRASE: 'text-amber-400',
  BROAD:  'text-slate-400',
};

function ScoreBar({ value, max = 1, color = 'bg-cyan' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="w-full h-1.5 bg-surface-3 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ModelStatusBadge({ status, score }) {
  const configs = {
    production:       { color: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300', label: 'Produção' },
    validated:        { color: 'bg-blue-500/20 border-blue-500/30 text-blue-300', label: 'Validado' },
    testing:          { color: 'bg-amber-500/20 border-amber-500/30 text-amber-300', label: 'Testando' },
    learning:         { color: 'bg-violet-500/20 border-violet-500/30 text-violet-300', label: 'Aprendendo' },
    insufficient_data:{ color: 'bg-slate-500/20 border-slate-500/30 text-slate-400', label: 'Dados Insuf.' },
  };
  const cfg = configs[status] || configs.learning;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-bold ${cfg.color}`}>
      <Brain className="w-3 h-3" />
      {cfg.label} · {score || 0}%
    </span>
  );
}

export default function KeywordMLDashboard() {
  const [predictions, setPredictions] = useState([]);
  const [modelVersion, setModelVersion] = useState(null);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);
  const [message, setMessage] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [tailFilter, setTailFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accs.length) accs = await base44.entities.AmazonAccount.list();
      const acc = accs[0];
      if (!acc) return;
      setAccount(acc);

      const [preds, versions] = await Promise.all([
        base44.entities.KeywordPrediction.filter({ amazon_account_id: acc.id }, '-keyword_quality_score', 300),
        base44.entities.MLModelVersion.filter({ amazon_account_id: acc.id }, '-training_date', 1),
      ]);

      setPredictions(preds.filter(p => !['rejected', 'blocked', 'expired'].includes(p.status)));
      setModelVersion(versions[0] || null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runPipeline = async (dryRun = false) => {
    if (!account || running) return;
    setRunning(true);
    setMessage(null);
    try {
      const res = await base44.functions.invoke('runKeywordMLPipeline', {
        amazon_account_id: account.id,
        dry_run: dryRun,
        max_per_asin: 10,
      });
      const d = res?.data || {};
      if (d.ok) {
        const txt = dryRun
          ? `Simulação: ${d.candidates_generated} candidatos · Status modelo: ${d.model_status} (${d.readiness_score}%)`
          : `✓ ${d.saved} predições geradas para ${d.active_products} produtos · ${d.search_terms_processed} termos analisados`;
        setMessage({ type: 'success', text: txt });
        if (!dryRun) await load();
      } else {
        setMessage({ type: 'error', text: d.error || 'Erro na execução' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
    }
  };

  const recalibrate = async () => {
    if (!account || recalibrating) return;
    setRecalibrating(true);
    setMessage(null);
    try {
      const res = await base44.functions.invoke('recalibrateKeywordMLModel', { amazon_account_id: account.id });
      const d = res?.data || {};
      setMessage({ type: 'success', text: `Recalibrado: ${d.updated} predições · ${d.successful} bem-sucedidas · ${d.underperforming} abaixo` });
      await load();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setRecalibrating(false);
    }
  };

  const approve = async (pred) => {
    try {
      await base44.entities.KeywordPrediction.update(pred.id, { status: 'approved', approved_at: new Date().toISOString() });
      setMessage({ type: 'success', text: `"${pred.keyword}" aprovada para criação.` });
      setPredictions(ps => ps.map(p => p.id === pred.id ? { ...p, status: 'approved' } : p));
    } catch (e) { setMessage({ type: 'error', text: e.message }); }
  };

  const reject = async (pred) => {
    try {
      await base44.entities.KeywordPrediction.update(pred.id, { status: 'rejected' });
      setPredictions(ps => ps.filter(p => p.id !== pred.id));
    } catch (e) { setMessage({ type: 'error', text: e.message }); }
  };

  // Filtros
  const filtered = predictions.filter(p => {
    const matchStatus = statusFilter === 'all' || p.status === statusFilter;
    const matchTail = tailFilter === 'all' || p.tail_type === tailFilter;
    const q = search.toLowerCase();
    const matchSearch = !q || `${p.keyword} ${p.asin} ${p.sku}`.toLowerCase().includes(q);
    return matchStatus && matchTail && matchSearch;
  });

  // Stats
  const totalScored = predictions.filter(p => p.status === 'scored').length;
  const totalExperimental = predictions.filter(p => p.status === 'experimental').length;
  const totalApproved = predictions.filter(p => p.status === 'approved').length;
  const totalSuccessful = predictions.filter(p => p.status === 'successful').length;
  const avgQuality = predictions.length > 0
    ? predictions.reduce((s, p) => s + (p.keyword_quality_score || 0), 0) / predictions.length : 0;
  const avgConvProb = predictions.length > 0
    ? predictions.reduce((s, p) => s + (p.conversion_probability || 0), 0) / predictions.length : 0;

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
            <Brain className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Palavras-chave de Alta Conversão</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Motor de ML determinístico · {predictions.length} predições ativas
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button onClick={() => runPipeline(true)} disabled={running || loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50">
            <FlaskConical className="w-3.5 h-3.5" />
            Simular
          </button>
          <button onClick={recalibrate} disabled={recalibrating || loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50">
            {recalibrating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BarChart2 className="w-3.5 h-3.5" />}
            Recalibrar
          </button>
          <button onClick={() => runPipeline(false)} disabled={running || loading}
            className="flex items-center gap-1.5 px-4 py-2 text-xs bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 rounded-lg font-semibold transition-colors disabled:opacity-50">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {running ? 'Executando...' : 'Gerar Predições'}
          </button>
          <button onClick={load} className="p-2 bg-surface-2 border border-surface-3 rounded-lg text-slate-400 hover:text-white transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Model Status + KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="col-span-2 lg:col-span-1 bg-surface-1 border border-surface-2 rounded-xl p-4 flex flex-col gap-2">
          <p className="text-[10px] text-slate-500 uppercase font-semibold">Status do Modelo</p>
          {modelVersion ? (
            <>
              <ModelStatusBadge status={modelVersion.status} score={modelVersion.readiness_score} />
              <p className="text-[10px] text-slate-500 mt-1">
                Precisão: {pct(modelVersion.precision)} · Erro: {pct(modelVersion.acos_prediction_error)}
              </p>
              <p className="text-[10px] text-slate-600">{modelVersion.version} · {modelVersion.training_records} termos</p>
            </>
          ) : (
            <span className="text-xs text-slate-500">Nenhum modelo treinado</span>
          )}
        </div>
        {[
          { label: 'Pontuadas', value: totalScored, color: 'text-emerald-400' },
          { label: 'Experimentais', value: totalExperimental, color: 'text-amber-400' },
          { label: 'Aprovadas', value: totalApproved, color: 'text-cyan' },
          { label: 'Bem-sucedidas', value: totalSuccessful, color: 'text-emerald-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
            <p className="text-[10px] text-slate-500 uppercase font-semibold mb-2">{label}</p>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Model metrics row */}
      {modelVersion && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Precisão do Modelo', value: pct(modelVersion.precision), sub: 'predições corretas' },
            { label: 'Acurácia Conversão', value: pct(modelVersion.conversion_prediction_accuracy), sub: 'erro de previsão' },
            { label: 'Lucro Gerado', value: `R$ ${fmt(modelVersion.profit_generated)}`, sub: 'desde o último treino' },
            { label: 'Com Vendas', value: `${modelVersion.total_with_sales || 0}`, sub: `de ${modelVersion.total_created || 0} criadas` },
          ].map(({ label, value, sub }) => (
            <div key={label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3">
              <p className="text-[10px] text-slate-500 uppercase">{label}</p>
              <p className="text-lg font-bold text-white mt-1">{value}</p>
              <p className="text-[10px] text-slate-500">{sub}</p>
            </div>
          ))}
        </div>
      )}

      {/* Message */}
      {message && (
        <div className={`rounded-lg px-4 py-3 text-sm ${message.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
          {message.text}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar palavra, ASIN..."
            className="w-full pl-3 pr-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-violet-500/40" />
        </div>
        <div className="flex items-center gap-1">
          <Filter className="w-3.5 h-3.5 text-slate-500" />
          {['all','scored','experimental','candidate','approved'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${statusFilter === s ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'text-slate-500 hover:text-white'}`}>
              {s === 'all' ? 'Todos' : STATUS_CONFIG[s]?.label || s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {['all','long','medium','short'].map(t => (
            <button key={t} onClick={() => setTailFilter(t)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${tailFilter === t ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'text-slate-500 hover:text-white'}`}>
              {t === 'all' ? 'Todas caudas' : TAIL_CONFIG[t]?.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-violet-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-12 text-center">
          <Brain className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">Nenhuma predição encontrada.</p>
          <p className="text-slate-600 text-xs mt-1">Clique em "Gerar Predições" para executar o pipeline de ML.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Palavra-chave', 'Produto', 'Cauda / Match', 'Score', 'Conv. Prob.', 'CPC Esp.', 'ACoS Esp.', 'ROAS Esp.', 'Status', 'Ações'].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-[10px] uppercase text-slate-500 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(pred => {
                  const isExpanded = expandedId === pred.id;
                  const tailCfg = TAIL_CONFIG[pred.tail_type] || TAIL_CONFIG.medium;
                  const statusCfg = STATUS_CONFIG[pred.status] || STATUS_CONFIG.candidate;
                  const isDone = ['approved', 'created', 'monitoring', 'successful'].includes(pred.status);

                  return [
                    <tr key={pred.id} onClick={() => setExpandedId(isExpanded ? null : pred.id)}
                      className="border-b border-surface-2/40 hover:bg-surface-2/20 cursor-pointer transition-colors">
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1.5">
                          {isExpanded ? <ChevronDown className="w-3 h-3 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-500 flex-shrink-0" />}
                          <div>
                            <p className="font-semibold text-white text-xs">{pred.keyword}</p>
                            <p className="text-[10px] text-slate-500">{pred.source?.replace(/_/g, ' ')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <p className="text-xs text-slate-300 font-mono">{pred.asin}</p>
                        {pred.sku && <p className="text-[10px] text-slate-500">{pred.sku}</p>}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${tailCfg.color}`}>{tailCfg.label}</span>
                        <p className={`text-[10px] font-bold mt-1 ${MATCH_COLOR[pred.match_type] || 'text-slate-400'}`}>{pred.match_type}</p>
                      </td>
                      <td className="px-3 py-3 min-w-[100px]">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-violet-400">{pct(pred.keyword_quality_score)}</span>
                        </div>
                        <ScoreBar value={pred.keyword_quality_score} color="bg-violet-500" />
                        <p className="text-[10px] text-slate-600 mt-0.5">conf. {pct(pred.confidence)}</p>
                      </td>
                      <td className="px-3 py-3">
                        <p className={`text-xs font-bold ${pred.conversion_probability >= 0.7 ? 'text-emerald-400' : pred.conversion_probability >= 0.4 ? 'text-amber-400' : 'text-slate-400'}`}>
                          {pct(pred.conversion_probability)}
                        </p>
                        <ScoreBar value={pred.conversion_probability} color={pred.conversion_probability >= 0.7 ? 'bg-emerald-500' : pred.conversion_probability >= 0.4 ? 'bg-amber-500' : 'bg-slate-600'} />
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-300">R${fmt(pred.expected_cpc)}</td>
                      <td className="px-3 py-3">
                        <span className={`text-xs font-semibold ${pred.expected_acos > 0 && pred.expected_acos <= 30 ? 'text-emerald-400' : pred.expected_acos > 30 && pred.expected_acos <= 45 ? 'text-amber-400' : 'text-red-400'}`}>
                          {pred.expected_acos > 0 ? `${fmt(pred.expected_acos, 1)}%` : '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-300">
                        {pred.expected_roas > 0 ? `${fmt(pred.expected_roas)}x` : '—'}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusCfg.color}`}>
                          {statusCfg.label}
                        </span>
                      </td>
                      <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          {!isDone && (
                            <button onClick={() => approve(pred)}
                              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 hover:bg-emerald-500/25 rounded-lg transition-colors">
                              <CheckCircle className="w-3 h-3" />
                              Aprovar
                            </button>
                          )}
                          {!isDone && (
                            <button onClick={() => reject(pred)}
                              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors">
                              <XCircle className="w-3 h-3" />
                            </button>
                          )}
                          {isDone && (
                            <span className={`text-[10px] px-2 py-1 rounded-lg ${pred.status === 'successful' ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-500'}`}>
                              {pred.status === 'successful' ? '✓ Sucesso' : pred.status === 'approved' ? 'Aprovada' : 'Em uso'}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>,
                    isExpanded && (
                      <tr key={`${pred.id}-detail`} className="border-b border-surface-2/40 bg-surface-2/10">
                        <td colSpan={10} className="px-6 py-4">
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                            {/* Explicação */}
                            <div className="lg:col-span-2">
                              <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Explicação da Recomendação</p>
                              <p className="text-xs text-slate-300 leading-relaxed">{pred.reason || 'Candidato gerado por análise de dados históricos.'}</p>
                              <div className="flex flex-wrap gap-3 mt-3">
                                <div>
                                  <p className="text-[10px] text-slate-500">Bid Recomendado</p>
                                  <p className="text-sm font-bold text-cyan">R$ {fmt(pred.recommended_bid)}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] text-slate-500">Ação Recomendada</p>
                                  <p className="text-xs text-slate-300">{pred.recommended_action?.replace(/_/g, ' ') || '—'}</p>
                                </div>
                                <div>
                                  <p className="text-[10px] text-slate-500">Versão do Modelo</p>
                                  <p className="text-xs text-slate-400 font-mono">{pred.model_version}</p>
                                </div>
                              </div>
                            </div>
                            {/* Métricas históricas */}
                            <div>
                              <p className="text-[10px] text-slate-500 uppercase font-semibold mb-2">Dados Históricos</p>
                              <div className="grid grid-cols-3 gap-1.5">
                                {[
                                  { label: 'Impressões', value: pred.historical_impressions || 0 },
                                  { label: 'Cliques', value: pred.historical_clicks || 0 },
                                  { label: 'Pedidos', value: pred.historical_orders || 0 },
                                  { label: 'Gasto', value: `R$${fmt(pred.historical_spend)}` },
                                  { label: 'Vendas', value: `R$${fmt(pred.historical_sales)}` },
                                  { label: 'CPC', value: `R$${fmt(pred.historical_cpc)}` },
                                  { label: 'Conv.', value: `${(Number(pred.historical_conversion_rate || 0) * 100).toFixed(1)}%` },
                                  { label: 'ACoS', value: pred.historical_acos > 0 ? `${fmt(pred.historical_acos, 1)}%` : '—' },
                                  { label: 'ROAS', value: pred.historical_roas > 0 ? `${fmt(pred.historical_roas)}x` : '—' },
                                ].map(({ label, value }) => (
                                  <div key={label} className="bg-surface-2 rounded-lg px-2 py-1.5">
                                    <p className="text-[9px] text-slate-500">{label}</p>
                                    <p className="text-xs font-semibold text-white">{value}</p>
                                  </div>
                                ))}
                              </div>
                              {pred.actual_orders > 0 && (
                                <div className="mt-2 p-2 bg-emerald-500/8 border border-emerald-500/20 rounded-lg">
                                  <p className="text-[10px] text-emerald-400 font-semibold">Resultados Reais</p>
                                  <p className="text-xs text-slate-300">
                                    {pred.actual_orders} pedidos · R${fmt(pred.actual_sales)} · ACoS {fmt(pred.actual_acos, 1)}%
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <p className="text-xs text-slate-600 text-right">{filtered.length} de {predictions.length} predições</p>
      )}
    </div>
  );
}