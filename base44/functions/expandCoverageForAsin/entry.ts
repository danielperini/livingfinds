/**
 * expandCoverageForAsin v2 — Backend automático
 *
 * Cria campanhas manuais EXACT canônicas (1:1) para ASINs elegíveis.
 * Invocado pelo orchestrador diário — sem UI, sem aprovação humana.
 * Motor determinístico assume controle de bids/pausas no próximo ciclo.
 *
 * Fontes de termos (em ordem de prioridade):
 *  1. KeywordBank: lifecycle IN [WINNER, PROVEN, CANDIDATE] + intent_score >= 75
 *  2. KeywordSuggestion: confidence >= 0.95
 *  3. Keywords EXACT de campanhas multi-keyword do mesmo ASIN (migração canônica)
 *
 * Após cada criação: negativar na campanha AUTO (fire-and-forget).
 * Idempotente: checkKeywordDuplicates bloqueia re-criações.
 * Máx: 5 ASINs por execução, 30 campanhas por ASIN.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const DEFAULT_BID = 0.50;
const DEFAULT_BUDGET = 9.00;
const DELAY_MS = 3500;
const MAX_ASINS_PER_RUN = 5;
const MAX_CAMPAIGNS_PER_ASIN = 30;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

function extractKeywordFromCampaignName(name: string): string | null {
  const parts = String(name || '').split('|').map(p => p.trim());
  if (parts.length >= 5) return parts.slice(4).join(' | ').trim() || null;
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

    const { amazon_account_id: bodyAccountId, asin: bodyAsin, max_campaigns = MAX_CAMPAIGNS_PER_ASIN, trigger_type = 'automatic' } = body;

    // ── Resolver conta ────────────────────────────────────────────────────
    let account: any = null;
    if (bodyAccountId) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: bodyAccountId }, null, 1).catch(() => []);
      account = rows[0];
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1).catch(() => []);
      account = rows[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const aid = account.id;
    const today = new Date().toISOString().slice(0, 10);

    // ── Resolver ASINs elegíveis ──────────────────────────────────────────
    let eligibleAsins: string[] = [];

    if (bodyAsin) {
      eligibleAsins = [String(bodyAsin).toUpperCase()];
    } else {
      // Todos os produtos authorized + eligible + com estoque
      const products = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid, ads_scope_status: 'authorized', ads_eligibility_status: 'eligible' }, null, 200
      ).catch(() => []);

      const eligible = products.filter((p: any) => Number(p.fba_inventory || 0) > 0 && p.asin);

      // Priorizar ASINs com menos campanhas manuais ativas
      const manualCamps = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid, targeting_type: 'MANUAL' }, null, 1000
      ).catch(() => []);

      const manualCountByAsin = new Map<string, number>();
      for (const c of manualCamps) {
        const state = String(c.state || c.status || '').toLowerCase();
        if (state === 'archived') continue;
        if (c.asin) manualCountByAsin.set(c.asin, (manualCountByAsin.get(c.asin) || 0) + 1);
      }

      eligible.sort((a: any, b: any) => (manualCountByAsin.get(a.asin) || 0) - (manualCountByAsin.get(b.asin) || 0));
      eligibleAsins = eligible.slice(0, MAX_ASINS_PER_RUN).map((p: any) => String(p.asin).toUpperCase());
    }

    if (eligibleAsins.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'no_eligible_asins' });
    }

    const globalReport: any = {
      ok: true,
      trigger_type,
      asins_processed: 0,
      total_campaigns_created: 0,
      total_skipped_duplicate: 0,
      total_failed: 0,
      by_asin: [],
    };

    // ── Carregar dados compartilhados ────────────────────────────────────
    const [allKeywords, allCampaigns] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 5000).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 2000).catch(() => []),
    ]);

    // Índice: keywords EXACT por asin (normalizadas) — para verificar cobertura existente
    const coveredTermsByAsin = new Map<string, Set<string>>();
    for (const kw of allKeywords) {
      const mt = String(kw.match_type || '').toLowerCase();
      if (mt !== 'exact') continue;
      const state = String(kw.state || kw.status || '').toLowerCase();
      if (state === 'archived') continue;
      const asin = String(kw.asin || '').toUpperCase();
      if (!asin) continue;
      const text = normTerm(kw.keyword_text || kw.keyword || '');
      if (!text) continue;
      if (!coveredTermsByAsin.has(asin)) coveredTermsByAsin.set(asin, new Set());
      coveredTermsByAsin.get(asin)!.add(text);
    }
    // Também extrair do nome das campanhas
    for (const c of allCampaigns) {
      const state = String(c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      const asin = String(c.asin || '').toUpperCase();
      if (!asin || String(c.targeting_type || '').toUpperCase() !== 'MANUAL') continue;
      const kw = extractKeywordFromCampaignName(c.name || c.campaign_name || '');
      if (kw) {
        if (!coveredTermsByAsin.has(asin)) coveredTermsByAsin.set(asin, new Set());
        coveredTermsByAsin.get(asin)!.add(normTerm(kw));
      }
    }

    // ── Processar cada ASIN ───────────────────────────────────────────────
    for (const asin of eligibleAsins) {
      const asinReport: any = {
        asin,
        terms_found: 0,
        campaigns_created: 0,
        campaigns_skipped: 0,
        campaigns_failed: 0,
        created: [],
        errors: [],
      };

      const covered = coveredTermsByAsin.get(asin) || new Set<string>();
      const candidateTerms = new Set<string>();

      // ── FONTE 1: KeywordBank (WINNER/PROVEN/CANDIDATE + intent >= 75) ──
      try {
        const bankTerms = await base44.asServiceRole.entities.KeywordBank.filter(
          { amazon_account_id: aid, asin }, null, 300
        ).catch(() => []);

        const validStatuses = new Set(['WINNER', 'PROVEN', 'CANDIDATE']);
        for (const kb of bankTerms) {
          if (!validStatuses.has(kb.lifecycle_status)) continue;
          if (Number(kb.intent_score || 0) < 75) continue;
          const t = normTerm(kb.normalized_keyword || kb.keyword || '');
          if (t && !covered.has(t)) candidateTerms.add(t);
        }
      } catch {}

      // ── FONTE 2: KeywordSuggestion (confidence >= 0.95) ───────────────
      try {
        const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
          { amazon_account_id: aid, asin }, null, 200
        ).catch(() => []);

        for (const s of suggestions) {
          const confidence = Number(s.confidence || s.confidence_score || s.score || 0);
          if (confidence < 0.95) continue;
          const t = normTerm(s.keyword_text || s.keyword || '');
          if (t && !covered.has(t)) candidateTerms.add(t);
        }
      } catch {}

      // ── FONTE 3: Keywords EXACT de campanhas multi-keyword (migração) ──
      try {
        const multiKwCamps = allCampaigns.filter((c: any) => {
          const state = String(c.state || c.status || '').toLowerCase();
          if (state === 'archived') return false;
          if (String(c.targeting_type || '').toUpperCase() !== 'MANUAL') return false;
          return String(c.asin || '').toUpperCase() === asin;
        });

        const campIds = multiKwCamps.map((c: any) => c.campaign_id || c.amazon_campaign_id).filter(Boolean);
        for (const cid of campIds) {
          const campKws = allKeywords.filter((k: any) =>
            k.campaign_id === cid &&
            String(k.match_type || '').toLowerCase() === 'exact' &&
            String(k.state || k.status || '').toLowerCase() !== 'archived'
          );
          for (const kw of campKws) {
            const t = normTerm(kw.keyword_text || kw.keyword || '');
            if (t && !covered.has(t)) candidateTerms.add(t);
          }
        }
      } catch {}

      asinReport.terms_found = candidateTerms.size;

      if (candidateTerms.size === 0) {
        globalReport.by_asin.push(asinReport);
        globalReport.asins_processed++;
        continue;
      }

      // ── Criar campanhas canônicas ─────────────────────────────────────
      let created = 0;
      for (const term of Array.from(candidateTerms)) {
        if (created >= max_campaigns) break;

        // Verificar duplicata
        try {
          const dupCheck = await base44.asServiceRole.functions.invoke('checkKeywordDuplicates', {
            amazon_account_id: aid,
            asin,
            keywords: [{ keyword_text: term, match_type: 'exact' }],
            _service_role: true,
          });
          const dupData = dupCheck?.data || dupCheck;
          if (dupData?.has_duplicates && (dupData?.allowed || []).length === 0) {
            asinReport.campaigns_skipped++;
            covered.add(term); // atualizar cache local
            continue;
          }
        } catch {}

        // Criar campanha
        try {
          const createRes = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
            amazon_account_id: aid,
            asin,
            keyword: term,
            bid: DEFAULT_BID,
            budget: DEFAULT_BUDGET,
            match_type: 'exact',
            bidding_strategy: 'DOWN_ONLY',
            initial_state: 'enabled',
            _service_role: true,
          });
          const cd = createRes?.data || createRes;

          if (cd?.ok) {
            if (cd?.already_exists || cd?.blocked_duplicate) {
              asinReport.campaigns_skipped++;
            } else {
              created++;
              asinReport.campaigns_created++;
              asinReport.created.push({ keyword: term, campaign_id: cd.campaign_id });
              covered.add(term);

              // Negativar na AUTO (fire-and-forget)
              base44.asServiceRole.functions.invoke('negateKeywordInAutoCampaign', {
                amazon_account_id: aid,
                asin,
                keyword_text: term,
                manual_campaign_id: cd.campaign_id,
                triggered_by: 'expand_coverage_auto',
                _service_role: true,
              }).catch(() => {});
            }
          } else {
            asinReport.campaigns_failed++;
            asinReport.errors.push({ keyword: term, error: cd?.error || 'unknown' });
          }
        } catch (e: any) {
          asinReport.campaigns_failed++;
          asinReport.errors.push({ keyword: term, error: e.message });
        }

        await sleep(DELAY_MS);
      }

      globalReport.total_campaigns_created += asinReport.campaigns_created;
      globalReport.total_skipped_duplicate += asinReport.campaigns_skipped;
      globalReport.total_failed += asinReport.campaigns_failed;
      globalReport.by_asin.push(asinReport);
      globalReport.asins_processed++;
    }

    globalReport.completed_at = new Date().toISOString();

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'expand_coverage_auto',
      trigger_type,
      status: globalReport.total_failed > 0 ? 'warning' : 'success',
      started_at: startedAt,
      completed_at: globalReport.completed_at,
      records_processed: globalReport.total_campaigns_created,
      result_summary: JSON.stringify({
        asins_processed: globalReport.asins_processed,
        total_campaigns_created: globalReport.total_campaigns_created,
        total_skipped: globalReport.total_skipped_duplicate,
        total_failed: globalReport.total_failed,
      }).slice(0, 4000),
    }).catch(() => {});

    return Response.json(globalReport);

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});