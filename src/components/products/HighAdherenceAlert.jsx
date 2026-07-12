import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { TrendingUp, X, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';

/**
 * Alerta: ASINs com TermBank com adesão >= 95% mas sem o termo vendedor vinculado.
 * "Termo vendedor" = entry no TermBank com source vinda de uma conversão real (has_sales = true ou orders > 0).
 */
export default function HighAdherenceAlert({ accountId, onDismiss }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    load();
  }, [accountId]);

  async function load() {
    setLoading(true);
    try {
      // Buscar todos os TermBank com adesão alta (confidence_score >= 0.95 ou adherence_score >= 0.95)
      const terms = await base44.entities.TermBank.filter(
        { amazon_account_id: accountId },
        '-created_date',
        500
      );

      // Agrupar por ASIN e verificar quais têm >= 95% de adesão mas NÃO têm nenhum termo com vendas
      const asinMap = {};
      for (const t of terms) {
        const asin = t.asin;
        if (!asin) continue;
        if (!asinMap[asin]) asinMap[asin] = { asin, terms: [], hasSalesTerm: false, topTerm: null, maxScore: 0 };
        const score = Number(t.confidence_score || t.adherence_score || t.quality_score || 0);
        asinMap[asin].terms.push({ ...t, score });
        if (score > asinMap[asin].maxScore) {
          asinMap[asin].maxScore = score;
          asinMap[asin].topTerm = t.keyword_text || t.term;
        }
        // Tem termo vendedor = tem conversões reais registradas
        if (t.has_sales || Number(t.orders || 0) > 0 || Number(t.conversions || 0) > 0) {
          asinMap[asin].hasSalesTerm = true;
        }
      }

      // Filtrar ASINs com alta adesão (score >= 0.95) sem termo vendedor
      const candidates = Object.values(asinMap).filter(
        a => a.maxScore >= 0.95 && !a.hasSalesTerm
      );

      // Enriquecer com nome do produto
      if (candidates.length > 0) {
        const asins = candidates.map(c => c.asin);
        const products = await base44.entities.Product.filter(
          { amazon_account_id: accountId, asin: { $in: asins } },
          null, asins.length + 5
        );
        const productMap = {};
        for (const p of products) { if (p.asin) productMap[p.asin] = p; }
        for (const c of candidates) {
          const p = productMap[c.asin];
          c.productName = p?.display_name || p?.product_name || c.asin;
          c.campaignStatus = p?.campaign_status;
        }
      }

      setItems(candidates.sort((a, b) => b.maxScore - a.maxScore));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  if (loading || dismissed || items.length === 0) return null;

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/8 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <TrendingUp className="w-4 h-4 text-violet-400 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-violet-300">
              {items.length} ASIN{items.length > 1 ? 's' : ''} com adesão ≥ 95% sem termo vendedor
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              Estes ASINs têm termos de alto potencial mas nenhuma conversão registrada ainda — considere vincular e ativar campanhas.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'Ocultar' : `Ver ${items.length}`}
          </button>
          <button type="button" onClick={handleDismiss} className="p-1.5 text-slate-500 hover:text-slate-300 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-violet-500/15 pt-3 space-y-2">
          {items.map(item => (
            <div key={item.asin} className="flex items-center gap-3 px-3 py-2 bg-surface-2 rounded-lg">
              <AlertCircle className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono font-bold text-cyan">{item.asin}</span>
                  <span className="text-xs text-slate-400 truncate max-w-[200px]">{item.productName}</span>
                  {item.campaignStatus && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      item.campaignStatus === 'active' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
                      item.campaignStatus === 'paused' ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' :
                      'bg-slate-500/10 border-slate-500/20 text-slate-400'
                    }`}>
                      {item.campaignStatus}
                    </span>
                  )}
                </div>
                {item.topTerm && (
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Melhor termo: <span className="text-violet-300 font-mono">{item.topTerm}</span>
                    <span className="ml-1 text-violet-400/70">({(item.maxScore * 100).toFixed(0)}% adesão)</span>
                  </p>
                )}
              </div>
              <span className="text-[11px] text-violet-400 font-semibold flex-shrink-0">
                {item.terms.length} termos
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}