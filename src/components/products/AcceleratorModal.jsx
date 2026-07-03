import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, CheckCircle, Loader2, Rocket, Sparkles, X } from 'lucide-react';

const cents = (value) => Math.round(Number(value || 0) * 100) / 100;

function allSuggestions(data) {
  return [...(data?.medium_tail || []), ...(data?.long_tail || [])]
    .filter((item) => item?.status === 'suggested' && item?.id)
    .sort((a, b) => {
      const scoreA = Number(a.confidence || 0) * Number(a.relevance_score || 0);
      const scoreB = Number(b.confidence || 0) * Number(b.relevance_score || 0);
      return scoreB - scoreA;
    });
}

export default function AcceleratorModal({ product, account, onClose, onDone }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState('');

  const accelerate = async () => {
    if (!account?.id || !product?.asin || running) return;

    setRunning(true);
    setError(null);
    setResult(null);

    try {
      setProgress('Gerando palavras-chave de alta intenção com IA...');
      const suggestionResponse = await base44.functions.invoke('suggestProductKeywordsWithAI', {
        amazon_account_id: account.id,
        asin: product.asin,
        product_id: product.id,
        requested_count: 4,
        minimum_confidence: 0.95,
        acceleration_mode: true,
      });

      if (!suggestionResponse?.data?.ok) {
        throw new Error(suggestionResponse?.data?.error || 'Não foi possível gerar palavras-chave com IA.');
      }

      const candidates = allSuggestions(suggestionResponse.data);
      const highConfidence = candidates.filter((item) => Number(item.confidence || 0) >= 0.95);
      const selected = highConfidence.slice(0, 4);

      if (selected.length < 4) {
        throw new Error(`A IA encontrou apenas ${selected.length} palavra(s) com confiança estimada mínima de 95%. Nenhuma alteração foi aplicada.`);
      }

      setProgress('Criando 4 palavras-chave manuais exatas...');
      const createResponse = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
        amazon_account_id: account.id,
        suggestion_ids: selected.map((item) => item.id),
        overrides: Object.fromEntries(selected.map((item) => [item.id, {
          bid: cents(item.recommended_bid || 0.30),
          budget: Number(item.recommended_budget || 5),
        }])),
      });

      const creationResults = createResponse?.data?.results || [];
      const createdCount = creationResults.filter((item) => item.ok || item.already_exists).length;
      if (createdCount < 4) {
        throw new Error(`Somente ${createdCount} das 4 palavras-chave foram criadas ou já existiam.`);
      }

      setProgress('Aumentando os bids relacionados em R$ 0,10 por 48 horas...');
      const campaigns = await base44.entities.Campaign.filter({
        amazon_account_id: account.id,
        asin: product.asin,
      });
      const campaignIds = new Set(campaigns.map((campaign) => String(campaign.campaign_id)));
      const keywords = await base44.entities.Keyword.filter({ amazon_account_id: account.id });
      const eligibleKeywords = keywords.filter((keyword) =>
        campaignIds.has(String(keyword.campaign_id)) &&
        String(keyword.state || keyword.status || 'enabled').toLowerCase() !== 'archived' &&
        keyword.keyword_id
      );

      const sessionId = `ACCELERATOR_48H:${product.asin}:${Date.now()}`;
      const startedAt = new Date();
      const dueAt = new Date(startedAt.getTime() + 48 * 60 * 60 * 1000).toISOString();
      let bidsUpdated = 0;
      const failures = [];

      for (const keyword of eligibleKeywords) {
        const originalBid = cents(keyword.current_bid ?? keyword.bid ?? keyword.default_bid ?? 0.30);
        const newBid = cents(originalBid + 0.10);
        const campaign = campaigns.find((item) => String(item.campaign_id) === String(keyword.campaign_id));

        try {
          const action = await base44.entities.AgentAction.create({
            amazon_account_id: account.id,
            action: 'update_bid',
            asin: product.asin,
            campaign_id: keyword.campaign_id,
            keyword_id: keyword.keyword_id,
            keyword: keyword.keyword_text,
            old_value: originalBid,
            new_value: newBid,
            reason: sessionId,
            evidence: JSON.stringify({
              acceleration_session: sessionId,
              started_at: startedAt.toISOString(),
              evaluation_due_at: dueAt,
              original_bid: originalBid,
              accelerated_bid: newBid,
              baseline_spend: Number(campaign?.spend_30d ?? campaign?.spend ?? 0),
              baseline_sales: Number(campaign?.sales_30d ?? campaign?.sales ?? 0),
              baseline_orders: Number(campaign?.orders_30d ?? campaign?.orders ?? 0),
              baseline_roas: Number(campaign?.roas_30d ?? campaign?.roas ?? 0),
              baseline_acos: Number(campaign?.acos_30d ?? campaign?.acos ?? 0),
              confidence_is_estimated: true,
            }),
            risk_level: 'medium',
            requires_approval: false,
          });

          const execution = await base44.functions.invoke('executeAgentAction', {
            action_id: action.id,
            approve: true,
          });
          if (!execution?.data?.ok) throw new Error(execution?.data?.error || 'Amazon recusou o novo bid.');
          bidsUpdated += 1;
        } catch (actionError) {
          failures.push(`${keyword.keyword_text || keyword.keyword_id}: ${actionError.message}`);
        }
      }

      await base44.entities.LearningEvent.create({
        amazon_account_id: account.id,
        event_type: 'product_acceleration_started',
        entity_type: 'product',
        entity_id: product.asin,
        observation: JSON.stringify({
          session_id: sessionId,
          asin: product.asin,
          started_at: startedAt.toISOString(),
          evaluation_due_at: dueAt,
          keyword_suggestions: selected.map((item) => ({
            keyword: item.keyword,
            confidence: item.confidence,
            relevance_score: item.relevance_score,
          })),
          bids_updated: bidsUpdated,
        }),
        recorded_at: startedAt.toISOString(),
      }).catch(() => {});

      setResult({
        keywords: selected,
        bidsUpdated,
        dueAt,
        failures,
      });
      setProgress('');
      onDone?.();
    } catch (runError) {
      setError(runError?.message || 'Falha ao acelerar o produto.');
      setProgress('');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={(event) => {
      if (event.target === event.currentTarget && !running) onClose();
    }}>
      <div className="w-full max-w-xl rounded-2xl border border-surface-2 bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-surface-2 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-400/10">
              <Rocket className="h-5 w-5 text-violet-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Aceleração inteligente por 48 horas</h2>
              <p className="font-mono text-xs text-slate-400">{product?.asin} {product?.sku ? `· ${product.sku}` : ''}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={running} className="text-slate-500 hover:text-white disabled:opacity-40" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="rounded-xl border border-violet-400/20 bg-violet-400/5 p-4 text-sm text-slate-300">
            <div className="mb-2 flex items-center gap-2 font-semibold text-violet-300">
              <Sparkles className="h-4 w-4" /> Experimento controlado
            </div>
            <p>Cria 4 palavras-chave exatas de alta intenção, com confiança estimada mínima de 95%, e aumenta em R$ 0,10 os bids das campanhas relacionadas durante 48 horas.</p>
          </div>

          <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-relaxed text-amber-200">
            <div className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Regras após 48 horas</div>
            Campanhas que apenas gastarem e não venderem serão pausadas. Bids que reduzirem ROAS ou aumentarem excessivamente o custo voltarão ao valor original. Campanhas com resultado positivo seguirão a gestão normal de anúncios.
          </div>

          {progress && (
            <div className="flex items-center gap-2 rounded-lg bg-cyan/10 px-3 py-2 text-xs text-cyan">
              <Loader2 className="h-4 w-4 animate-spin" /> {progress}
            </div>
          )}

          {error && <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</div>}

          {result && (
            <div className="space-y-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300"><CheckCircle className="h-4 w-4" /> Aceleração iniciada</div>
              <p className="text-xs text-slate-300">4 palavras-chave processadas · {result.bidsUpdated} bids aumentados.</p>
              <div className="space-y-1">
                {result.keywords.map((item) => (
                  <div key={item.id} className="flex justify-between gap-3 text-xs text-slate-400">
                    <span>{item.keyword}</span><span>{Math.round(Number(item.confidence) * 100)}%</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500">Avaliação automática: {new Date(result.dueAt).toLocaleString('pt-BR')}</p>
              {result.failures.length > 0 && <p className="text-[11px] text-amber-300">{result.failures.length} bid(s) não puderam ser alterados.</p>}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={running} className="rounded-lg border border-surface-3 px-4 py-2 text-sm text-slate-300 hover:text-white disabled:opacity-50">
              {result ? 'Fechar' : 'Cancelar'}
            </button>
            {!result && (
              <button type="button" onClick={accelerate} disabled={running || !account} className="flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                {running ? 'Acelerando...' : 'Acelerar por 48 horas'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
