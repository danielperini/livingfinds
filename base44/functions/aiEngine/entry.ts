/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║           LIVINGFINDS AI ENGINE — FONTE ÚNICA DE IA DO SISTEMA          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Ponto de entrada único para TODA inteligência artificial da plataforma.
 * Todos os demais módulos de IA devem invocar este endpoint.
 *
 * ── MÓDULOS INTEGRADOS ────────────────────────────────────────────────────
 * 1. AUTOPILOT          → runDailyAdsOptimization (motor principal decisório)
 * 2. SMART_BID          → smartBidFromCpc (bid = 50% do CPC real)
 * 3. CALIBRATE_BIDS     → calibrateBidsNoImpressions (teto R$1.20, piso R$0.25)
 * 4. HARVEST            → harvestConvertedSearchTerms (colheita de termos convertidos)
 * 5. MINE_OPPORTUNITIES → mineSearchTermOpportunities (novas campanhas manuais)
 * 6. NEGATE             → negateKeywordInAutoCampaign (negativação automática)
 * 7. CLAUDE_ANALYZE     → claudeAdsAgent (análise livre com Claude + Policy Engine)
 * 8. FULL               → executa todos os módulos em sequência
 *
 * ── REGRAS GLOBAIS DO MOTOR (hardcoded aqui como fonte canônica) ──────────
 * - Bid inicial de toda campanha nova:  R$0.50
 * - Piso mínimo de bid:                 R$0.25
 * - Teto sem impressões:                R$1.20 (sobe +R$0.10 a cada 24h)
 * - Com CPC real (≥2 cliques):         bid = 50% do CPC
 * - Teto máximo global:                 R$5.00
 * - Cooldown redução:                   24h
 * - Cooldown aumento:                   72h
 * - Janela de atribuição:               72h (safe_cutoff)
 * - Confiança mínima para execução:     60%
 *
 * ── USO ──────────────────────────────────────────────────────────────────
 * POST /aiEngine
 * {
 *   "mode": "autopilot" | "smart_bid" | "calibrate_bids" | "harvest" |
 *           "mine_opportunities" | "negate" | "claude_analyze" | "full" | "ping",
 *   "amazon_account_id": "...",  // opcional — usa conta conectada padrão
 *   "prompt": "...",              // obrigatório para mode=claude_analyze
 *   "context": { ... }            // opcional para mode=claude_analyze
 * }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── CONSTANTES GLOBAIS (fonte canônica de todas as regras) ─────────────────
export const AI_ENGINE_RULES = {
  INITIAL_BID:          0.50,  // bid inicial de toda campanha nova
  MIN_BID:              0.25,  // piso mínimo global
  MAX_BID_NO_IMPRESSION: 1.20, // teto do ciclo sem impressão
  MAX_BID_GLOBAL:       5.00,  // teto absoluto
  CPC_BID_RATIO:        0.50,  // bid = 50% do CPC real
  BOOST_NO_IMPRESSION:  0.10,  // +R$0.10 por ciclo sem impressão
  REDUCE_WITH_IMPRESSION: 0.05,// -R$0.05 ao recuperar impressão
  MIN_DELTA:            0.05,  // diferença mínima para ajuste
  COOLDOWN_DECREASE_H:  24,
  COOLDOWN_INCREASE_H:  72,
  ATTRIBUTION_SAFETY_H: 72,
  MIN_CLICKS_FOR_CPC:   2,     // mínimo de cliques para usar CPC real
  MIN_CONFIDENCE:       0.60,
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { mode = 'ping', amazon_account_id, prompt, context } = body;

    const now = new Date().toISOString();

    // ── PING ─────────────────────────────────────────────────────────────
    if (mode === 'ping') {
      return Response.json({
        ok: true,
        engine: 'LivingFinds AI Engine v1',
        rules: AI_ENGINE_RULES,
        modules: ['autopilot', 'smart_bid', 'calibrate_bids', 'harvest', 'mine_opportunities', 'negate', 'claude_analyze', 'full'],
        canonical: true,
        timestamp: now,
      });
    }

    const results = {};
    const errors = [];

    // Helper para invocar sub-funções com tratamento de erro
    async function invoke(fn, payload = {}) {
      try {
        const res = await base44.asServiceRole.functions.invoke(fn, {
          amazon_account_id,
          ...payload,
        });
        return res?.data || res;
      } catch (e) {
        errors.push(`${fn}: ${e.message}`);
        return { ok: false, error: e.message };
      }
    }

    // ── MÓDULO: AUTOPILOT (motor principal decisório) ─────────────────────
    if (mode === 'autopilot' || mode === 'full') {
      results.autopilot = await invoke('runDailyAdsOptimization', { trigger: mode === 'full' ? 'full_engine' : 'manual' });
    }

    // ── MÓDULO: SMART_BID (bid = 50% do CPC real) ─────────────────────────
    if (mode === 'smart_bid' || mode === 'full') {
      results.smart_bid = await invoke('smartBidFromCpc');
    }

    // ── MÓDULO: CALIBRATE_BIDS (sem impressões → +R$0.10; com impressões → -R$0.05) ─
    if (mode === 'calibrate_bids' || mode === 'full') {
      results.calibrate_bids = await invoke('calibrateBidsNoImpressions');
    }

    // ── MÓDULO: HARVEST (colheita de termos convertidos → keywords manuais) ─
    if (mode === 'harvest' || mode === 'full') {
      results.harvest = await invoke('harvestConvertedSearchTerms');
    }

    // ── MÓDULO: MINE_OPPORTUNITIES (busca oportunidades de campanhas manuais) ─
    if (mode === 'mine_opportunities' || mode === 'full') {
      results.mine_opportunities = await invoke('mineSearchTermOpportunities');
    }

    // ── MÓDULO: NEGATE (negativação automática após criação de campanha manual) ─
    if (mode === 'negate') {
      const { asin, keyword_text, manual_campaign_id, triggered_by } = body;
      if (!asin || !keyword_text) {
        return Response.json({ ok: false, error: 'asin e keyword_text obrigatórios para mode=negate' }, { status: 400 });
      }
      results.negate = await invoke('negateKeywordInAutoCampaign', { asin, keyword_text, manual_campaign_id, triggered_by });
    }

    // ── MÓDULO: CLAUDE_ANALYZE (análise livre com Claude + Policy Engine) ─
    if (mode === 'claude_analyze') {
      if (!prompt) {
        return Response.json({ ok: false, error: 'prompt obrigatório para mode=claude_analyze' }, { status: 400 });
      }
      results.claude = await invoke('claudeAdsAgent', { mode: 'analyze', prompt, context });
    }

    // ── Modo desconhecido ─────────────────────────────────────────────────
    if (!Object.keys(results).length && mode !== 'ping') {
      return Response.json({
        ok: false,
        error: `Modo desconhecido: "${mode}". Modos válidos: ping, autopilot, smart_bid, calibrate_bids, harvest, mine_opportunities, negate, claude_analyze, full`,
      }, { status: 400 });
    }

    return Response.json({
      ok: errors.length === 0,
      mode,
      engine: 'LivingFinds AI Engine v1',
      rules: AI_ENGINE_RULES,
      results,
      errors: errors.length > 0 ? errors : undefined,
      executed_at: now,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});