import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Package, ChevronDown, ChevronUp, Loader2, RefreshCw,
  AlertTriangle, CheckCircle, Zap, Clock
} from 'lucide-react';

// Heatmap 24h por ASIN com cores semânticas
function AsinHeatmap({ peakHours, lowHours, neutralHours }) {
  const peakSet    = new Set(peakHours || []);
  const lowSet     = new Set(lowHours || []);

  return (
    <div className="mt-3">
      <p className="text-xs text-slate-500 mb-2">Mapa horário 0h–23h</p>
      <div className="flex gap-0.5 flex-wrap">
        {Array.from({ length: 24 }, (_, h) => {
          const isPeak = peakSet.has(h);
          const isLow  = lowSet.has(h);
          return (
            <div
              key={h}
              title={`${h}h — ${isPeak ? '🟢 Pico' : isLow ? '🔴 Baixa' : '⬜ Neutro'}`}
              className={`w-7 h-7 rounded flex items-center justify-center text-[9px] font-bold cursor-default border ${
                isPeak ? 'bg-emerald-500 border-emerald-400 text-white'
                       : isLow ? 'bg-red-600/70 border-red-500 text-white'
                       : 'bg-slate-700/40 border-slate-600/30 text-slate-500'
              }`}
            >
              {h}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-2">
        <div className="flex items-center gap-1 text-[10px] text-slate-400">
          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> Pico
        </div>
        <div className="flex items-center gap-1 text-[10px] text-slate-400">
          <span className="w-2.5 h-2.5 rounded-sm bg-slate-700/60 inline-block" /> Neutro
        </div>
        <div className="flex items-center gap-1 text-[10px] text-slate-400">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-600/70 inline-block" /> Baixa
        </div>
      </div>
    </div>
  );
}

function formatHours(json) {
  try {
    const arr = JSON.parse(json || '[]');
    if (!arr.length) return '—';
    // Group consecutive
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted.map(h => `${String(h).padStart(2,'0')}h`).join(', ');
  } catch {
    return '—';
  }
}

function MaturityBadge({ maturity }) {
  if (maturity === 'sufficient') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-emerald-500/15 border-emerald-500/25 text-emerald-400">
        <CheckCircle className="w-3 h-3" /> Maduro
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-amber-500/15 border-amber-500/25 text-amber-400">
      <AlertTriangle className="w-3 h-3" /> Insuficiente
    </span>
  );
}

export default function AsinPeakProfilesPanel({ account }) {
  const [profiles, setProfiles]   = useState([]);
  const [products, setProducts]   = useState({});
  const [loading, setLoading]     = useState(true);
  const [running, setRunning]     = useState(false);
  const [msg, setMsg]             = useState(null);
  const [expanded, setExpanded]   = useState(null);
  const [filterMature, setFilterMature] = useState('all');

  const loadProfiles = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      // Carregar perfis ASIN: registros com asin preenchido e hora=0, dia=0 (âncora do perfil)
      const all = await base44.entities.HourlySalesPattern.filter(
        { amazon_account_id: account.id, day_of_week: 0, hour: 0 },
        '-asin_profile_updated_at', 200
      ).catch(() => []);

      const withAsin = all.filter(p => !!p.asin && p.asin_data_maturity);
      setProfiles(withAsin);

      // Enriquecer com nomes de produtos
      const asins = [...new Set(withAsin.map(p => p.asin))];
      if (asins.length) {
        const prods = await base44.entities.Product.filter(
          { amazon_account_id: account.id },
          null, 500
        ).catch(() => []);
        const prodMap = {};
        for (const p of prods) if (p.asin) prodMap[p.asin] = p;
        setProducts(prodMap);
      }
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const runLearning = async () => {
    if (!account || running) return;
    setRunning(true);
    setMsg(null);
    try {
      const res = await base44.functions.invoke('runAsinPeakProfileLearning', {
        amazon_account_id: account.id,
      });
      const d = res?.data;
      if (d?.ok) {
        const r = d.results?.[0];
        setMsg({ type: 'success', text: `✓ ${r?.asins_mature || 0} ASINs com perfil maduro · ${r?.asins_insufficient || 0} insuficientes de ${r?.asins_processed || 0} total` });
        await loadProfiles();
      } else {
        setMsg({ type: 'error', text: d?.error || 'Erro ao executar aprendizado' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setMsg(null), 12000);
    }
  };

  const filtered = profiles.filter(p => {
    if (filterMature === 'mature') return p.asin_data_maturity === 'sufficient';
    if (filterMature === 'insufficient') return p.asin_data_maturity === 'insufficient';
    return true;
  });

  const matureCount = profiles.filter(p => p.asin_data_maturity === 'sufficient').length;
  const insuffCount = profiles.filter(p => p.asin_data_maturity === 'insufficient').length;
  const divergentCount = profiles.filter(p => p.asin_peak_diverges_from_account).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-cyan animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + botão */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-white">Perfis Horários por Produto (ASIN)</p>
          <p className="text-xs text-slate-500 mt-0.5">
            O motor aprende o horário real de pico de cada ASIN e ajusta bids individualmente — independente do padrão geral da conta.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadProfiles} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runLearning} disabled={running}
            className="flex items-center gap-2 px-4 py-2 bg-cyan/15 border border-cyan/30 text-cyan text-sm font-semibold rounded-lg hover:bg-cyan/25 disabled:opacity-60 transition-colors">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {running ? 'Aprendendo...' : 'Executar Aprendizado'}
          </button>
        </div>
      </div>

      {msg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${
          msg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'
        }`}>
          {msg.text}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Perfis Maduros</p>
          <p className="text-2xl font-bold text-emerald-400">{matureCount}</p>
          <p className="text-[10px] text-slate-500">≥30 dias · ≥20 cliques/hora</p>
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Dados Insuficientes</p>
          <p className="text-2xl font-bold text-amber-400">{insuffCount}</p>
          <p className="text-[10px] text-slate-500">Usando regras genéricas da conta</p>
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Pico Próprio Detectado</p>
          <p className="text-2xl font-bold text-cyan">{divergentCount}</p>
          <p className="text-[10px] text-slate-500">Pico difere &gt;3h da média da conta</p>
        </div>
      </div>

      {/* Filtro */}
      <div className="flex items-center gap-1.5">
        {[
          { key: 'all', label: `Todos (${profiles.length})` },
          { key: 'mature', label: `Maduros (${matureCount})` },
          { key: 'insufficient', label: `Insuficientes (${insuffCount})` },
        ].map(f => (
          <button key={f.key} onClick={() => setFilterMature(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              filterMature === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Tabela / lista de ASINs */}
      {!filtered.length ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Package className="w-10 h-10 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhum perfil encontrado.</p>
          <p className="text-xs text-slate-500">Clique em "Executar Aprendizado" para gerar os perfis horários por ASIN.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(profile => {
            const asin = profile.asin;
            const prod = products[asin];
            const isOpen = expanded === asin;
            const mature = profile.asin_data_maturity === 'sufficient';
            const peakHours = (() => { try { return JSON.parse(profile.asin_peak_hours_json || '[]'); } catch { return []; } })();
            const lowHours  = (() => { try { return JSON.parse(profile.asin_low_hours_json || '[]');  } catch { return []; } })();
            const neutralHours = (() => { try { return JSON.parse(profile.asin_neutral_hours_json || '[]'); } catch { return []; } })();
            const updatedAt = profile.asin_profile_updated_at
              ? new Date(profile.asin_profile_updated_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
              : '—';

            return (
              <div key={asin} className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : asin)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface-2/40 transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Thumbnail */}
                    {prod?.product_image_url ? (
                      <img src={prod.product_image_url} alt={asin} className="w-10 h-10 rounded-lg object-cover flex-shrink-0 bg-surface-3" />
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
                        <Package className="w-4 h-4 text-slate-600" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-mono font-semibold text-cyan">{asin}</span>
                        <MaturityBadge maturity={profile.asin_data_maturity} />
                        {profile.asin_peak_diverges_from_account && mature && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-violet-500/15 border-violet-500/25 text-violet-300">
                            <Zap className="w-2.5 h-2.5" /> Pico próprio detectado
                          </span>
                        )}
                      </div>
                      {prod && (
                        <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[300px]">
                          {prod.display_name || prod.product_name || `Produto ${asin}`}
                        </p>
                      )}
                      <p className="text-[10px] text-slate-600 mt-0.5">
                        {profile.asin_days_of_data || 0} dias de dados · {profile.asin_total_clicks || 0} cliques · atualizado {updatedAt}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {mature && (
                      <div className="hidden sm:flex items-center gap-2 text-xs">
                        {peakHours.length > 0 && (
                          <span className="flex items-center gap-1 text-emerald-400">
                            <Clock className="w-3 h-3" />
                            {peakHours.slice(0,3).map(h => `${String(h).padStart(2,'0')}h`).join(' ')}
                            {peakHours.length > 3 && `+${peakHours.length-3}`}
                          </span>
                        )}
                      </div>
                    )}
                    {isOpen ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                  </div>
                </button>

                {isOpen && (
                  <div className="px-5 pb-5 border-t border-surface-2">
                    {!mature ? (
                      <div className="mt-4 p-4 rounded-lg bg-amber-500/8 border border-amber-500/20">
                        <p className="text-xs font-semibold text-amber-300 mb-1">Dados insuficientes para perfil individualizado</p>
                        <p className="text-xs text-amber-400/70">
                          Este ASIN precisa de ≥30 dias de histórico e ≥20 cliques por faixa horária.
                          Atualmente: {profile.asin_days_of_data || 0} dias, {profile.asin_total_clicks || 0} cliques totais.
                          O motor continua usando as regras genéricas da conta.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div className="bg-surface-2 rounded-lg p-3">
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Janelas de Pico</p>
                            <p className="text-sm font-semibold text-emerald-400">{formatHours(profile.asin_peak_hours_json)}</p>
                            <p className="text-[10px] text-slate-500 mt-1">Boost +20–30% de bid</p>
                          </div>
                          <div className="bg-surface-2 rounded-lg p-3">
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Janelas Neutras</p>
                            <p className="text-sm font-semibold text-slate-300">{formatHours(profile.asin_neutral_hours_json)}</p>
                            <p className="text-[10px] text-slate-500 mt-1">Bid base mantido</p>
                          </div>
                          <div className="bg-surface-2 rounded-lg p-3">
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Janelas de Baixa</p>
                            <p className="text-sm font-semibold text-red-400">{formatHours(profile.asin_low_hours_json)}</p>
                            <p className="text-[10px] text-slate-500 mt-1">Redução ao piso</p>
                          </div>
                        </div>

                        <AsinHeatmap
                          peakHours={peakHours}
                          lowHours={lowHours}
                          neutralHours={neutralHours}
                        />

                        {profile.asin_peak_diverges_from_account && (
                          <div className="mt-3 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
                            <p className="text-[11px] text-violet-300">
                              <strong>Pico próprio detectado:</strong> o pico deste ASIN difere &gt;3h do pico médio da conta.
                              O motor aplicará boost/redução baseado neste perfil específico, ignorando o horário genérico.
                            </p>
                          </div>
                        )}

                        <div className="mt-3 flex items-center gap-4 text-[10px] text-slate-500">
                          <span>{profile.asin_days_of_data} dias de histórico</span>
                          <span>·</span>
                          <span>{profile.asin_total_clicks?.toLocaleString('pt-BR')} cliques acumulados</span>
                          <span>·</span>
                          <span>Score mínimo de pico: {profile.asin_peak_score_threshold?.toFixed(2)}</span>
                          <span>·</span>
                          <span>Atualizado: {updatedAt}</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Nota sobre integração com o motor */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Como o motor usa estes perfis</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            { icon: '🎯', title: 'Bid por pico do ASIN', desc: 'Na janela de pico do produto, aplica +20–30% mesmo que seja hora fraca para a conta' },
            { icon: '📉', title: 'Redução individualizada', desc: 'Na janela de baixa do produto, reduz ao piso mesmo que seja hora forte para a conta' },
            { icon: '⏰', title: 'Retomada antecipada', desc: 'Se campanha pausada e pico previsto em 1-2h, retoma preventivamente (budget ≥20% do cap)' },
            { icon: '🛡️', title: 'Guardrail de maturidade', desc: 'ASINs sem perfil maduro (< 30 dias ou < 20 cliques/h) continuam com regras genéricas da conta' },
          ].map(item => (
            <div key={item.title} className="flex items-start gap-2 p-2.5 bg-surface-2/50 rounded-lg">
              <span className="text-base flex-shrink-0">{item.icon}</span>
              <div>
                <p className="text-xs font-semibold text-slate-300">{item.title}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}