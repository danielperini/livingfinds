import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Sparkles, Loader2, ChevronDown, ChevronUp, Megaphone, CheckCircle, Clock, AlertTriangle } from 'lucide-react';

const MATCH_COLORS = {
  exact:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  phrase: 'bg-cyan/15 text-cyan border-cyan/25',
  broad:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

export default function IASuggestionsTab({ account }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState({}); // { asin: [] }
  const [generating, setGenerating] = useState({}); // { asin: bool }
  const [scheduling, setScheduling] = useState({}); // { key: bool }
  const [scheduled, setScheduled] = useState({}); // { key: status }
  const [expanded, setExpanded] = useState({});
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const prods = await base44.entities.Product.filter(
        { amazon_account_id: account.id },
        '-updated_date', 200
      );
      const active = prods.filter(p => p.status === 'active' && p.asin);
      setProducts(active);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => { load(); }, [load]);

  const generateForAsin = async (product) => {
    const asin = product.asin;
    if (generating[asin]) return;
    setGenerating(prev => ({ ...prev, [asin]: true }));
    setExpanded(prev => ({ ...prev, [asin]: true }));
    try {
      const res = await base44.functions.invoke('suggestProductKeywordsWithAI', {
        amazon_account_id: account.id,
        asin,
        product_name: product.product_name || product.display_name || asin,
        count: 10,
        focus: 'cauda_longa',
      });
      const d = res?.data || res || {};
      const kws = d?.keywords || d?.suggestions || [];
      setSuggestions(prev => ({ ...prev, [asin]: kws }));
    } catch (e) {
      setMsg({ type: 'error', text: `Erro ao gerar para ${asin}: ${e.message}` });
      setTimeout(() => setMsg(null), 8000);
    } finally {
      setGenerating(prev => ({ ...prev, [asin]: false }));
    }
  };

  const scheduleCampaign = async (asin, kw, productName) => {
    const key = `${asin}::${kw}`;
    if (scheduling[key]) return;
    setScheduling(prev => ({ ...prev, [key]: true }));
    try {
      const res = await base44.functions.invoke('scheduleManualCampaignFromTerm', {
        amazon_account_id: account.id,
        asin,
        keyword: kw,
        product_name: productName,
      });
      const d = res?.data || {};
      const status = d?.executed ? 'executed' : d?.already_exists || d?.already_queued ? 'exists' : d?.ok ? 'queued' : 'error';
      setScheduled(prev => ({ ...prev, [key]: status }));
    } catch {
      setScheduled(prev => ({ ...prev, [key]: 'error' }));
    } finally {
      setScheduling(prev => ({ ...prev, [key]: false }));
    }
  };

  if (loading) return (
    <div className="flex justify-center py-20">
      <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
    </div>
  );

  if (!products.length) return (
    <div className="text-center py-20 text-slate-500">
      <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
      <p>Nenhum produto ativo encontrado.</p>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 p-4 bg-violet-500/8 border border-violet-500/20 rounded-xl">
        <Sparkles className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-semibold text-violet-300">Sugestões por IA (GPT-4o)</p>
          <p className="text-[11px] text-slate-400 mt-0.5">Gera ≥10 keywords de cauda longa de alta relevância por ASIN. Clique em "Gerar" por produto — geração sob demanda para controlar créditos de IA.</p>
        </div>
      </div>

      {msg && (
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs ${msg.type === 'error' ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {msg.text}
        </div>
      )}

      {products.map(product => {
        const asin = product.asin;
        const kws = suggestions[asin] || [];
        const isExpanded = expanded[asin];
        const isGenerating = generating[asin];

        return (
          <div key={asin} className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            {/* Header do produto */}
            <div className="flex items-center gap-3 px-4 py-3">
              {product.product_image_url ? (
                <img src={product.product_image_url} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0 bg-surface-2" />
              ) : (
                <div className="w-9 h-9 rounded-lg bg-surface-2 border border-surface-3 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-white truncate">{product.product_name || product.display_name || 'Produto sem nome'}</p>
                <p className="text-[10px] font-mono text-cyan">{asin}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {kws.length > 0 && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/25 text-violet-400">
                    {kws.length} sugestões
                  </span>
                )}
                <button
                  onClick={() => generateForAsin(product)}
                  disabled={isGenerating}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold bg-violet-500/15 border border-violet-500/30 text-violet-400 hover:bg-violet-500/25 rounded-lg transition-colors disabled:opacity-50"
                >
                  {isGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  {isGenerating ? 'Gerando...' : kws.length > 0 ? 'Regerar' : 'Gerar'}
                </button>
                {kws.length > 0 && (
                  <button
                    onClick={() => setExpanded(prev => ({ ...prev, [asin]: !prev[asin] }))}
                    className="p-1.5 rounded-lg hover:bg-surface-2 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            </div>

            {/* Lista de keywords geradas */}
            {isExpanded && kws.length > 0 && (
              <div className="border-t border-surface-2 divide-y divide-surface-2/50">
                {kws.map((item, idx) => {
                  const kw = typeof item === 'string' ? item : (item.keyword || item.term || item);
                  const score = typeof item === 'object' ? (item.relevance_score || item.score || 0) : 0;
                  const matchType = typeof item === 'object' ? (item.match_type || 'exact') : 'exact';
                  const rationale = typeof item === 'object' ? (item.rationale || item.reason || '') : '';
                  const cpc = typeof item === 'object' ? (item.sustainable_cpc || item.cpc || 0) : 0;
                  const key = `${asin}::${kw}`;
                  const schedStatus = scheduled[key];

                  return (
                    <div key={idx} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/30">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-white">{kw}</span>
                          {matchType && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${MATCH_COLORS[matchType] || MATCH_COLORS.exact}`}>
                              {matchType}
                            </span>
                          )}
                          {score > 0 && (
                            <span className={`text-[10px] font-semibold ${score >= 85 ? 'text-emerald-400' : score >= 65 ? 'text-amber-400' : 'text-slate-400'}`}>
                              {score}/100
                            </span>
                          )}
                          {cpc > 0 && (
                            <span className="text-[10px] text-slate-500">CPC sust. R${Number(cpc).toFixed(2)}</span>
                          )}
                        </div>
                        {rationale && (
                          <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-[400px]">{rationale}</p>
                        )}
                      </div>
                      <div className="flex-shrink-0">
                        {schedStatus === 'executed' ? (
                          <span className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle className="w-3 h-3" />Criada</span>
                        ) : schedStatus === 'queued' ? (
                          <span className="flex items-center gap-1 text-[10px] text-amber-400"><Clock className="w-3 h-3" />Agendada</span>
                        ) : schedStatus === 'exists' ? (
                          <span className="text-[10px] text-slate-500">Já existe</span>
                        ) : (
                          <button
                            onClick={() => scheduleCampaign(asin, kw, product.product_name || asin)}
                            disabled={scheduling[key]}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border border-cyan/30 bg-cyan/10 text-cyan hover:bg-cyan/20 disabled:opacity-50 transition-colors whitespace-nowrap"
                          >
                            {scheduling[key] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Megaphone className="w-3 h-3" />}
                            Agendar
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}