/**
 * auditAutoManualCompetition
 *
 * Monitora campanhas AUTO e MANUAL ativas do mesmo ASIN e detecta quando
 * um termo/keyword da campanha MANUAL ainda não está negativado na AUTO.
 * Para cada colisão detectada, invoca negateKeywordInAutoCampaign (fire-and-forget).
 *
 * Idempotente: usa OptimizationDecision com status=executed como cache.
 * Executa via orchestrador diário (_service_role: true).
 *
 * Fontes de termos a verificar:
 *   1. Entidade Keyword: keywords EXACT ativas em campanhas MANUAL do ASIN
 *   2. Nome canônico da campanha: extrai keyword do padrão "SP | MANUAL | EXACT | ASIN | <keyword>"
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function normTerm(text: string): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrai keyword do nome canônico "SP | MANUAL | EXACT | ASIN | <keyword>" */
function extractKeywordFromCampaignName(name: string): string | null {
  const parts = String(name || '').split('|').map(p => p.trim());
  if (parts.length >= 5) return parts.slice(4).join(' | ').trim();
  return null;
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // ── Resolver conta ────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, skipped: true, reason: 'no_connected_account' });
    const aid = account.id;
    const today = new Date().toISOString().slice(0, 10);

    // ── Carregar campanhas MANUAL e AUTO ativas ───────────────────────────
    const [manualCampaigns, autoCampaigns, allKeywords, existingNegations] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid, targeting_type: 'MANUAL' }, null, 1000
      ).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid, targeting_type: 'AUTO' }, null, 200
      ).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid }, null, 3000
      ).catch(() => []),
      // Negativações já executadas hoje (cache de idempotência)
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, decision_type: 'negative_keyword', status: 'executed' },
        '-created_date', 500
      ).catch(() => []),
    ]);

    // ── Índice: AUTO ativa por ASIN ───────────────────────────────────────
    const autoByAsin = new Map<string, any>();
    for (const c of autoCampaigns) {
      const state = String(c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      if (!c.asin) continue;
      // Priorizar a com mais spend
      const existing = autoByAsin.get(c.asin);
      if (!existing || Number(c.spend || 0) > Number(existing.spend || 0)) {
        autoByAsin.set(c.asin, c);
      }
    }

    // ── Índice: keywords EXACT por campaign_id ────────────────────────────
    const kwByCampaign = new Map<string, string[]>();
    for (const kw of allKeywords) {
      const mt = String(kw.match_type || '').toLowerCase();
      if (mt !== 'exact') continue;
      const state = String(kw.state || kw.status || '').toLowerCase();
      if (state === 'archived') continue;
      const text = String(kw.keyword_text || kw.keyword || '').trim();
      if (!text) continue;
      const cid = kw.campaign_id || '';
      if (!kwByCampaign.has(cid)) kwByCampaign.set(cid, []);
      kwByCampaign.get(cid)!.push(text);
    }

    // ── Índice: negativas já existentes (asin|norm_keyword) ──────────────
    const negatedSet = new Set<string>();
    for (const d of existingNegations) {
      if (d.asin && d.keyword_text) {
        negatedSet.add(`${d.asin}|${normTerm(d.keyword_text)}`);
      }
    }

    // ── Detectar colisões ─────────────────────────────────────────────────
    const collisions: Array<{ asin: string; keyword: string; manual_campaign_id: string; auto_campaign_id: string }> = [];

    for (const camp of manualCampaigns) {
      const state = String(camp.state || camp.status || '').toLowerCase();
      if (state === 'archived') continue;
      const asin = camp.asin || '';
      if (!asin) continue;

      const autoCamp = autoByAsin.get(asin);
      if (!autoCamp) continue; // sem AUTO para este ASIN → sem competição

      const manualCampaignId = camp.campaign_id || camp.amazon_campaign_id || '';
      const autoCampaignId = autoCamp.campaign_id || autoCamp.amazon_campaign_id || '';

      // Fonte 1: keywords da entidade Keyword
      const kwFromEntity = kwByCampaign.get(manualCampaignId) || [];
      for (const kw of kwFromEntity) {
        const key = `${asin}|${normTerm(kw)}`;
        if (!negatedSet.has(key)) {
          collisions.push({ asin, keyword: kw, manual_campaign_id: manualCampaignId, auto_campaign_id: autoCampaignId });
          negatedSet.add(key); // evitar duplicata no mesmo ciclo
        }
      }

      // Fonte 2: keyword extraída do nome canônico da campanha
      const nameKw = extractKeywordFromCampaignName(camp.name || camp.campaign_name || '');
      if (nameKw) {
        const key = `${asin}|${normTerm(nameKw)}`;
        if (!negatedSet.has(key)) {
          collisions.push({ asin, keyword: nameKw, manual_campaign_id: manualCampaignId, auto_campaign_id: autoCampaignId });
          negatedSet.add(key);
        }
      }
    }

    const stats = {
      manual_campaigns_scanned: manualCampaigns.filter(c => String(c.state || c.status || '').toLowerCase() !== 'archived').length,
      auto_campaigns_active: autoByAsin.size,
      collisions_detected: collisions.length,
      negations_dispatched: 0,
      already_negated: negatedSet.size,
    };

    if (collisions.length === 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'audit_auto_manual_competition',
        trigger_type: body.trigger_type || 'automatic',
        status: 'success',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        records_processed: 0,
        result_summary: JSON.stringify({ ...stats, message: 'Nenhuma colisão detectada' }),
      }).catch(() => {});

      return Response.json({ ok: true, ...stats });
    }

    // ── Disparar negativações (fire-and-forget, máx 50 por ciclo) ────────
    const toProcess = collisions.slice(0, 50);
    for (const col of toProcess) {
      base44.asServiceRole.functions.invoke('negateKeywordInAutoCampaign', {
        amazon_account_id: aid,
        asin: col.asin,
        keyword_text: col.keyword,
        manual_campaign_id: col.manual_campaign_id,
        triggered_by: 'audit_auto_manual_competition',
        _service_role: true,
      }).catch(() => {});
      stats.negations_dispatched++;
    }

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'audit_auto_manual_competition',
      trigger_type: body.trigger_type || 'automatic',
      status: 'success',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: stats.negations_dispatched,
      result_summary: JSON.stringify(stats).slice(0, 4000),
    }).catch(() => {});

    return Response.json({ ok: true, ...stats, collisions_sample: collisions.slice(0, 10) });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});