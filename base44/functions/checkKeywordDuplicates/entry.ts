/**
 * checkKeywordDuplicates
 *
 * Validação centralizada anti-duplicata. Chamada ANTES de qualquer inserção de keyword.
 *
 * Recebe:
 *   amazon_account_id: string
 *   asin: string
 *   keywords: Array<{ keyword_text: string, match_type?: string }>
 *   campaign_id?: string   — se informado, verifica também dentro da mesma campanha
 *
 * Retorna:
 *   allowed: Array<{ keyword_text, match_type }>  — sem duplicata, podem ser criadas
 *   blocked: Array<{ keyword_text, match_type, reason, existing_campaign_id }>
 *   has_duplicates: boolean
 *
 * Regras:
 *  1. Normalização: lowercase + trim + sem acentos + espaços simples
 *  2. Bloqueia se existir keyword ENABLED com mesmo texto + mesmo ASIN (qualquer campanha)
 *  3. Bloqueia se existir keyword ENABLED com mesmo texto + mesma campanha (match_type ignorado)
 *  4. Não bloqueia keywords PAUSED ou ARCHIVED (permissivo — permite reativar)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[áàãâä]/g, 'a')
    .replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i')
    .replace(/[óòõôö]/g, 'o')
    .replace(/[úùûü]/g, 'u')
    .replace(/[ç]/g, 'c')
    .replace(/[ñ]/g, 'n');
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const isAuth = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { amazon_account_id, asin, keywords = [], campaign_id } = body;
    if (!amazon_account_id || !asin || keywords.length === 0) {
      return Response.json({ ok: false, error: 'amazon_account_id, asin e keywords[] são obrigatórios' }, { status: 400 });
    }

    // Buscar todas as keywords ENABLED do produto (qualquer campanha)
    const existing1 = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id, asin, state: 'enabled' }, null, 500
    ).catch(() => []);
    const existing2 = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id, asin, status: 'enabled' }, null, 500
    ).catch(() => []);

    // Deduplicar
    const seenIds = new Set<string>();
    const existingEnabled: any[] = [];
    for (const kw of [...existing1, ...existing2]) {
      if (!seenIds.has(kw.id)) { seenIds.add(kw.id); existingEnabled.push(kw); }
    }

    // Índice: normalized_text → campaign_id (para bloquear duplicata cross-campanha por ASIN)
    const byTextAsin = new Map<string, { campaign_id: string; keyword_id: string; keyword_text: string }>();
    // Índice: campaign_id|normalized_text → true (para bloquear duplicata dentro da mesma campanha)
    const byCampaignText = new Set<string>();

    for (const kw of existingEnabled) {
      const normalized = normalize(kw.keyword_text || kw.keyword || '');
      if (!normalized) continue;
      if (!byTextAsin.has(normalized)) {
        byTextAsin.set(normalized, {
          campaign_id: kw.campaign_id || '',
          keyword_id: kw.keyword_id || kw.id,
          keyword_text: kw.keyword_text || kw.keyword || '',
        });
      }
      if (kw.campaign_id) {
        byCampaignText.add(`${kw.campaign_id}|${normalized}`);
      }
    }

    const allowed: any[] = [];
    const blocked: any[] = [];

    for (const kw of keywords) {
      const text = kw.keyword_text || kw.keyword || '';
      const normalized = normalize(text);
      const match_type = kw.match_type || 'exact';

      // Regra 1: mesmo texto + mesmo ASIN em qualquer campanha ativa
      const existingCross = byTextAsin.get(normalized);
      if (existingCross) {
        blocked.push({
          keyword_text: text,
          match_type,
          reason: `Já existe keyword ENABLED "${existingCross.keyword_text}" para o ASIN ${asin} na campanha ${existingCross.campaign_id}`,
          existing_campaign_id: existingCross.campaign_id,
          existing_keyword_id: existingCross.keyword_id,
          rule: 'cross_campaign_asin_duplicate',
        });
        continue;
      }

      // Regra 2: mesmo texto dentro da mesma campanha de destino (se informada)
      if (campaign_id && byCampaignText.has(`${campaign_id}|${normalized}`)) {
        blocked.push({
          keyword_text: text,
          match_type,
          reason: `Já existe keyword ENABLED "${text}" na campanha ${campaign_id}`,
          existing_campaign_id: campaign_id,
          rule: 'same_campaign_duplicate',
        });
        continue;
      }

      allowed.push({ keyword_text: text, match_type });
    }

    return Response.json({
      ok: true,
      asin,
      total_checked: keywords.length,
      allowed_count: allowed.length,
      blocked_count: blocked.length,
      has_duplicates: blocked.length > 0,
      allowed,
      blocked,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});